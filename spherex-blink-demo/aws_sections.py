"""Read only the IMAGE rows a sky-map tile needs from SPHEREx L2 files on AWS, via byte ranges.

IRSA's cutout service streams at ~0.4 MB/s per connection and always ships the ~4 MB PSF
table. The public S3 copy (nasa-irsa-spherex) serves the same files 10-20x faster.

Map tiles skip the other extensions. ZODI varies by well under the noise across a tile
(at most one grey level in the PNG). FLAGS is mostly persistence marks; masking them and
filling from neighbours speckles the sky, while saturated cores are already NaN in IMAGE.
Single-visit tiles do read FLAGS (`flags=True`): there a cosmic ray or persistence ghost looks
exactly like a moving object, so its pixels are taken from another frame of the same visit.

Rows are fetched and cached in blocks shared by every tile, because neighbouring tiles
usually read the same full-width rows of the same frame.
"""
import asyncio
import math
from collections import OrderedDict

import httpx
import numpy as np
from astropy.io import fits
from astropy.io.fits.hdu.compressed._codecs import Rice1
from astropy.wcs import WCS

IBE_PREFIX = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
S3_PREFIX = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"

_BLOCK = 2880
# Covers the PRIMARY + IMAGE headers.
_HEAD_READ = 64 * 1024
# Bilinear interpolation reads one pixel past the edge; keep a little slack for SIP rounding.
_MARGIN_PX = 3
_BLOCK_ROWS = 64
# ~0.5 MB each (64 float32 rows of 2040 px).
_MAX_BLOCKS = 400
_MAX_HEADERS = 1024

# A home link saturates at ~3 parallel streams. Queueing row downloads beyond that (first
# come, first served; the page asks for centre tiles first) finishes tiles one after another
# instead of all of them together at the end. Header reads are small and skip the queue.
_row_downloads = asyncio.Semaphore(3)

_client = httpx.AsyncClient(
    timeout=httpx.Timeout(connect=8.0, read=20.0, write=8.0, pool=30.0),
    limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
)
# src -> task resolving to (IMAGE header, data offset)
_headers: OrderedDict[str, asyncio.Task] = OrderedDict()
# (src, block) -> (task fetching a run of blocks, index within the run)
_blocks: OrderedDict[tuple[str, int], tuple[asyncio.Task, int]] = OrderedDict()


class SectionUnavailable(RuntimeError):
    """The S3 copy cannot serve this file; use IRSA's cutout service instead."""


def s3_url(url):
    return S3_PREFIX + url[len(IBE_PREFIX):] if url.startswith(IBE_PREFIX) else None


async def _range(url, start, stop):
    """Bytes [start, stop) of `url`."""
    last = None
    for i in range(3):
        try:
            r = await _client.get(url, headers={"Range": f"bytes={start}-{stop - 1}"})
        except httpx.TransportError as e:
            last = e
        else:
            if r.status_code == 206:
                return r.content
            if r.status_code < 500:
                raise SectionUnavailable(f"S3 {r.status_code}")
            last = SectionUnavailable(f"S3 {r.status_code}")
        await asyncio.sleep(0.4 * (i + 1))
    raise SectionUnavailable(f"S3 read failed: {last}")


def _parse_header(buf, pos):
    """(header, header_bytes) for the header starting at buf[pos]; None if END lies past buf."""
    for i in range(pos, len(buf) - 79, 80):
        if buf[i:i + 8] == b"END     ":
            end = i + 80
            return fits.Header.fromstring(buf[pos:end].decode("ascii")), -(-(end - pos) // _BLOCK) * _BLOCK
    return None


async def _read_image_header(src):
    head = await _range(src, 0, _HEAD_READ)
    primary = _parse_header(head, 0)
    if primary is None or primary[0].get("NAXIS"):
        raise SectionUnavailable("unexpected primary HDU")
    image = _parse_header(head, primary[1])
    if image is None:
        raise SectionUnavailable("IMAGE header longer than one read")
    h = image[0]
    if h.get("EXTNAME") != "IMAGE" or h.get("NAXIS") != 2 or h.get("BITPIX") != -32:
        raise SectionUnavailable("unexpected IMAGE layout")
    return h, primary[1] + image[1]


async def _read_flags_index(src):
    """Where each FLAGS row lives: (row descriptors [(nbytes, heap offset)], heap start, width).

    FLAGS follows IMAGE's data. It is a RICE-compressed image with one detector row per
    tile, so any run of rows is one byte range of the heap (~3 kB per row).
    """
    image, data = await asyncio.shield(
        _shared(_headers, src, lambda: _read_image_header(src), _MAX_HEADERS))
    nx, ny = image["NAXIS1"], image["NAXIS2"]
    start = data + -(-nx * ny * 4 // _BLOCK) * _BLOCK
    head = await _range(src, start, start + _HEAD_READ)
    flags = _parse_header(head, 0)
    if flags is None:
        raise SectionUnavailable("FLAGS header longer than one read")
    h, size = flags
    if (h.get("EXTNAME") != "FLAGS" or not h.get("ZIMAGE") or h.get("ZCMPTYPE") != "RICE_1"
            or h.get("ZBITPIX") != 32 or (h.get("ZNAXIS1"), h.get("ZNAXIS2")) != (nx, ny)
            or (h.get("ZTILE1"), h.get("ZTILE2")) != (nx, 1)
            or h.get("NAXIS1") != 8 or h.get("NAXIS2") != ny or "THEAP" in h):
        raise SectionUnavailable("unexpected FLAGS layout")
    table = head[size:size + 8 * ny]
    if len(table) < 8 * ny:
        table = await _range(src, start + size, start + size + 8 * ny)
    index = np.frombuffer(table, ">i4").reshape(ny, 2).astype(np.int64)
    return index, start + size + 8 * ny, nx


def _rice_codec(nx):
    return Rice1(blocksize=32, bytepix=4, tilesize=nx)


def _shared(cache, key, factory, limit):
    """Cached task for `key`, started by `factory()` on first use; failures are not kept."""
    task = cache.get(key)
    if task is None:
        task = cache[key] = asyncio.ensure_future(factory())

        def done(t):
            if (t.cancelled() or t.exception() is not None) and cache.get(key) is t:
                del cache[key]

        task.add_done_callback(done)
        while len(cache) > limit:
            cache.popitem(last=False)
    else:
        cache.move_to_end(key)
    return task


async def _fetch_blocks(src, header, data, b0, b1):
    """IMAGE rows for blocks [b0, b1), split per block."""
    nx, ny = header["NAXIS1"], header["NAXIS2"]
    y0, y1 = b0 * _BLOCK_ROWS, min(ny, b1 * _BLOCK_ROWS)
    row = nx * 4
    async with _row_downloads:
        raw = await _range(src, data + y0 * row, data + y1 * row)
    image = np.frombuffer(raw, ">f4").reshape(y1 - y0, nx).astype(np.float32)
    return [image[i:i + _BLOCK_ROWS] for i in range(0, y1 - y0, _BLOCK_ROWS)]


async def _fetch_flag_blocks(src, flags_index, b0, b1):
    """FLAGS rows for blocks [b0, b1), decompressed and split per block."""
    index, heap, nx = flags_index
    y0, y1 = b0 * _BLOCK_ROWS, min(len(index), b1 * _BLOCK_ROWS)
    rows = index[y0:y1]
    lo, hi = int(rows[:, 1].min()), int((rows[:, 1] + rows[:, 0]).max())
    async with _row_downloads:
        raw = np.frombuffer(await _range(src, heap + lo, heap + hi), np.uint8)
    codec = _rice_codec(nx)
    image = np.stack([
        np.frombuffer(codec.decode(raw[off - lo:off - lo + n]), dtype=np.int32)
        for n, off in rows
    ])
    return [image[i:i + _BLOCK_ROWS] for i in range(0, y1 - y0, _BLOCK_ROWS)]


def _forget_on_error(task, keys):
    def done(t):
        if t.cancelled() or t.exception() is not None:
            for key in keys:
                if _blocks.get(key, (None,))[0] is t:
                    del _blocks[key]
    task.add_done_callback(done)


async def _rows(src, ext, fetch, y0, y1):
    """Rows [y0, y1) of extension `ext`, from shared cached blocks; `fetch(b0, b1)` reads
    the blocks still missing."""
    b0, b1 = y0 // _BLOCK_ROWS, -(-y1 // _BLOCK_ROWS)
    runs = []
    for b in range(b0, b1):
        if (src, ext, b) in _blocks:
            continue
        if runs and runs[-1][1] == b:
            runs[-1][1] = b + 1
        else:
            runs.append([b, b + 1])
    for r0, r1 in runs:
        task = asyncio.ensure_future(fetch(r0, r1))
        keys = [(src, ext, b) for b in range(r0, r1)]
        for i, key in enumerate(keys):
            _blocks[key] = (task, i)
        _forget_on_error(task, keys)
    refs = []
    for b in range(b0, b1):
        _blocks.move_to_end((src, ext, b))
        refs.append(_blocks[(src, ext, b)])
    while len(_blocks) > _MAX_BLOCKS:
        _blocks.popitem(last=False)
    parts = [(await asyncio.shield(task))[i] for task, i in refs]
    off = y0 - b0 * _BLOCK_ROWS
    return np.concatenate(parts)[off:off + y1 - y0]


def _row_span(in_wcs, out_wcs, box, nx, ny):
    """Input rows [y0, y1) under the output-pixel box (x0, x1, y0, y1)."""
    bx0, bx1, by0, by1 = box
    kx = np.linspace(bx0 - 0.5, bx1 - 0.5, 33)
    ky = np.linspace(by0 - 0.5, by1 - 0.5, 33)
    xs = np.concatenate([kx, kx, np.full_like(ky, bx0 - 0.5), np.full_like(ky, bx1 - 0.5)])
    ys = np.concatenate([np.full_like(kx, by0 - 0.5), np.full_like(kx, by1 - 0.5), ky, ky])
    ra, dec = out_wcs.pixel_to_world_values(xs, ys)
    px, py = in_wcs.all_world2pix(ra, dec, 0, quiet=True)
    if px.max() < -1 or px.min() > nx or py.max() < -1 or py.min() > ny:
        raise ValueError("frame does not reach the tile")
    y0 = max(0, int(math.floor(py.min())) - _MARGIN_PX)
    y1 = min(ny, int(math.ceil(py.max())) + _MARGIN_PX + 1)
    return y0, y1


async def get_section(url, out_wcs, shape, box=None, flags=False):
    """IMAGE rows (and FLAGS rows if `flags`) of one L2 file under part of the output grid.

    `box` is (x0, x1, y0, y1) in output pixels, end-exclusive; defaults to the whole grid.
    Raises SectionUnavailable when the file is not on S3 or its layout is unexpected,
    and ValueError when the frame does not reach the box.
    """
    src = s3_url(url)
    if src is None:
        raise SectionUnavailable("not an IRSA SPHEREx URL")
    header, data = await asyncio.shield(
        _shared(_headers, src, lambda: _read_image_header(src), _MAX_HEADERS))
    nx, ny = header["NAXIS1"], header["NAXIS2"]
    y0, y1 = _row_span(WCS(header), out_wcs, box or (0, shape[1], 0, shape[0]), nx, ny)

    async def flag_rows():
        index = await asyncio.shield(_shared(
            _headers, src + "#FLAGS", lambda: _read_flags_index(src), _MAX_HEADERS))
        return await _rows(src, "FLAGS", lambda b0, b1: _fetch_flag_blocks(src, index, b0, b1), y0, y1)

    image, mask = await asyncio.gather(
        _rows(src, "IMAGE", lambda b0, b1: _fetch_blocks(src, header, data, b0, b1), y0, y1),
        flag_rows() if flags else asyncio.sleep(0),
    )
    hdr = header.copy()
    hdr["CRPIX2"] = hdr["CRPIX2"] - y0
    hdus = [fits.PrimaryHDU(), fits.ImageHDU(image, header=hdr, name="IMAGE")]
    if flags:
        hdus.append(fits.ImageHDU(mask, name="FLAGS"))
    return fits.HDUList(hdus)
