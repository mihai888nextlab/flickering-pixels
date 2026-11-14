"""Instant low-resolution sky-map previews from IRSA's SPHEREx DR1 all-sky HiPS cube.

The HiPS is pre-tiled: 512 px PNG tiles of ~40 KB at 12.9"/px, about half the resolution of
the L2 frames. A 1° preview needs a few tiles instead of megabytes of frame rows, so the map
shows the sky within a second while the sharp tile is still downloading.

Cube frame index = 17 * (band - 1) + (channel - 1); a tile for frame f is Npix<n>_<f>.png
(Npix<n>.png for f = 0). The PNGs are already stretched (asinh, cut 0..40) and clip the
background to 0.
"""
import asyncio
import io
import math
from collections import OrderedDict

import astropy.units as u
import httpx
import numpy as np
from astropy.wcs import WCS
from astropy_healpix import HEALPix
from PIL import Image
from scipy.ndimage import maximum_filter, uniform_filter

import config

HIPS_URL = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube"
ORDER = 5
TILE_BITS = 9  # 512 px tiles
_HP = HEALPix(nside=2 ** (ORDER + TILE_BITS), order="nested")
PIXEL_DEG = _HP.pixel_resolution.to_value(u.deg)
# Middle channel of each detector's 17, away from the blank dichroic frames (50, 51).
_CHANNEL = 8
# HiPS greys -> roughly the sharp tiles' look: their background sits near grey 12, and
# above the background they run ~1.9x brighter than the HiPS stretch.
_BACKGROUND = 12.0
_GAIN = 1.9
_MAX_TILES = 256

_client = httpx.AsyncClient(
    timeout=httpx.Timeout(connect=8.0, read=15.0, write=8.0, pool=15.0),
    limits=httpx.Limits(max_connections=16, max_keepalive_connections=8),
    follow_redirects=True,
)
# (frame, tile) -> task resolving to a 512x512 uint8 array, or None where the HiPS has no tile.
_tiles: OrderedDict[tuple[int, int], asyncio.Task] = OrderedDict()
_TILE_DIR = config.CACHE_DIR / "hips-spherex"


def _tile_path(frame, tile):
    suffix = "" if frame == 0 else f"_{frame}"
    return f"Norder{ORDER}/Dir{(tile // 10000) * 10000}/Npix{tile}{suffix}.png"


async def _load_tile(frame, tile):
    rel = _tile_path(frame, tile)
    local = _TILE_DIR / rel
    if local.exists():
        data = local.read_bytes()
    else:
        last = None
        for attempt in range(3):
            try:
                r = await _client.get(f"{HIPS_URL}/{rel}")
            except httpx.TransportError as e:
                last = e
            else:
                if r.status_code == 404:
                    return None
                if r.status_code == 200:
                    break
                last = RuntimeError(f"HiPS {r.status_code}")
            await asyncio.sleep(0.5 * (attempt + 1))
        else:
            raise RuntimeError(f"HiPS tile {rel} failed: {last}")
        data = r.content
        local.parent.mkdir(parents=True, exist_ok=True)
        tmp = local.with_suffix(".part")
        tmp.write_bytes(data)
        tmp.replace(local)
    return np.array(Image.open(io.BytesIO(data)).convert("L"))


def _tile(frame, tile):
    key = (frame, tile)
    task = _tiles.get(key)
    if task is None:
        task = _tiles[key] = asyncio.ensure_future(_load_tile(frame, tile))

        def done(t):
            if (t.cancelled() or t.exception() is not None) and _tiles.get(key) is t:
                del _tiles[key]

        task.add_done_callback(done)
        while len(_tiles) > _MAX_TILES:
            _tiles.popitem(last=False)
    else:
        _tiles.move_to_end(key)
    return task


def _sample_grid(ra, dec, size):
    """Tile index, row and column in that tile for every pixel of a north-up preview grid."""
    n = max(16, math.ceil(size / PIXEL_DEG))
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-size / n, size / n]
    ys, xs = np.mgrid[0:n, 0:n]
    lon, lat = w.pixel_to_world_values(xs, ys)
    fine = _HP.lonlat_to_healpix(lon * u.deg, lat * u.deg)
    tile = fine >> (2 * TILE_BITS)
    sub = fine & ((1 << (2 * TILE_BITS)) - 1)
    # Nested sub-index bits interleave the tile's row (even bits) and column (odd bits).
    row = np.zeros_like(sub)
    col = np.zeros_like(sub)
    for b in range(TILE_BITS):
        row |= ((sub >> (2 * b)) & 1) << b
        col |= ((sub >> (2 * b + 1)) & 1) << b
    return tile, row, col


def _restyle(v):
    v = v.astype(np.float32)
    # Saturated star cores come through as 0 inside a bright ring; fill them from the ring.
    for _ in range(3):
        holes = (v == 0) & (uniform_filter((v > 60).astype(np.float32), size=3) >= 5 / 9)
        if not holes.any():
            break
        v = np.where(holes, maximum_filter(v, size=3), v)
    return np.clip(_BACKGROUND + v * _GAIN, 0, 255).astype(np.uint8)


async def render(ra, dec, size, detector):
    """Opaque greyscale PNG of the cell (north up, east left) at the HiPS resolution."""
    frame = 17 * (detector - 1) + _CHANNEL
    tile, row, col = await asyncio.to_thread(_sample_grid, ra, dec, size)
    ids = [int(t) for t in np.unique(tile)]
    arrays = await asyncio.gather(*(asyncio.shield(_tile(frame, t)) for t in ids))
    img = np.zeros(tile.shape, dtype=np.uint8)
    for t, arr in zip(ids, arrays):
        if arr is not None:
            m = tile == t
            img[m] = arr[row[m], col[m]]
    covered = any(arr is not None for arr in arrays)

    def encode():
        out = io.BytesIO()
        if covered:
            Image.fromarray(_restyle(img)[::-1], "L").save(out, format="PNG", optimize=False)
        else:
            # Same 1x1 answer as an uncovered sharp tile, which the map treats as a gap.
            Image.new("L", (1, 1)).save(out, format="PNG")
        return out.getvalue()

    return await asyncio.to_thread(encode)
