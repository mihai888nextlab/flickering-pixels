"""Turns SPHEREx cutouts into blink frames, difference images, RGB composites and spectra."""
import io
import warnings

import numpy as np
from astropy.time import Time
from astropy.wcs import WCS
from PIL import Image
from reproject import reproject_interp
from scipy.ndimage import maximum_filter

import config

warnings.simplefilter("ignore")

BAD_MASK = sum(1 << b for b in config.BAD_FLAG_BITS)
ARTIFACT_MASK = sum(1 << b for b in config.ARTIFACT_FLAG_BITS)


def target_wcs(ra, dec, size_deg):
    """North-up TAN grid centered on the target, at SPHEREx pixel scale."""
    n = int(np.ceil(size_deg * 3600 / config.PIXEL_SCALE_ARCSEC))
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-config.PIXEL_SCALE_ARCSEC / 3600, config.PIXEL_SCALE_ARCSEC / 3600]
    return w, (n, n)


def clean_image(hdul, bad_mask=BAD_MASK):
    """IMAGE minus zodiacal light, bad pixels → NaN, residual background removed."""
    img = hdul["IMAGE"].data.astype(float)
    if "ZODI" in hdul:
        img = img - hdul["ZODI"].data
    if "FLAGS" in hdul and bad_mask:
        img[(hdul["FLAGS"].data & bad_mask) != 0] = np.nan
    if np.isfinite(img).any():
        img -= np.nanmedian(img)
    return img


def flag_fraction(hdul):
    f = hdul["FLAGS"].data
    return float(((f & BAD_MASK) != 0).mean())


def flag_breakdown(hdul):
    """Fraction of cutout pixels carrying each contamination / quality bit."""
    f = hdul["FLAGS"].data
    out = {}
    for name, bit in config.CONTAM_FLAG_BITS.items():
        out[name] = round(float(((f & (1 << bit)) != 0).mean()), 4)
    return out


def photo_stats(reproj, det_stacks, shape):
    """Simple measurements from the reprojected cutouts (not catalog identity).

    - center_mjy_sr: median flux in a small aperture at the grid center
    - peak_snr: rough peak / MAD noise in the deepest detector stack
    - flagged_mean: mean bad-flag fraction across frames
    - ir_character: warm/cool/balanced from D1–D2 vs D5–D6 stack brightness
    """
    flagged_vals = [flag_fraction(h) for _, h, _ in reproj]
    flagged_mean = float(np.mean(flagged_vals)) if flagged_vals else 0.0

    cy, cx = (shape[0] - 1) / 2.0, (shape[1] - 1) / 2.0
    r = 2
    yi0, yi1 = max(0, int(cy) - r), min(shape[0], int(cy) + r + 1)
    xi0, xi1 = max(0, int(cx) - r), min(shape[1], int(cx) + r + 1)
    center_vals = []
    for _, _, arr in reproj:
        box = arr[yi0:yi1, xi0:xi1]
        if np.isfinite(box).any():
            center_vals.append(float(np.nanmedian(box)))
    center = float(np.median(center_vals)) if center_vals else None

    peak_snr = None
    deep = None
    for d in (6, 5, 4, 3, 2, 1):
        if det_stacks.get(d) is not None:
            deep = det_stacks[d]
            break
    if deep is not None and np.isfinite(deep).any():
        mad = float(np.nanmedian(np.abs(deep - np.nanmedian(deep))) * 1.4826)
        peak = float(np.nanpercentile(deep, 99.5))
        if mad > 0:
            peak_snr = round(peak / mad, 1)

    warm = []
    cool = []
    for d, bucket in ((1, cool), (2, cool), (5, warm), (6, warm)):
        s = det_stacks.get(d)
        if s is not None and np.isfinite(s).any():
            bucket.append(float(np.nanpercentile(np.abs(s), 90)))
    ir_character = None
    if warm and cool:
        wr, cr = sum(warm) / len(warm), sum(cool) / len(cool)
        ratio = wr / max(cr, 1e-12)
        if ratio > 1.4:
            ir_character = "warmer IR dominant"
        elif ratio < 0.7:
            ir_character = "shorter IR dominant"
        else:
            ir_character = "balanced IR"

    summary_bits = []
    if center is not None:
        summary_bits.append(f"center {center:+.3g} MJy/sr")
    if peak_snr is not None:
        summary_bits.append(f"peak ~{peak_snr:g}σ")
    if flagged_mean > 0:
        summary_bits.append(f"{100 * flagged_mean:.1f}% flagged")
    if ir_character:
        summary_bits.append(ir_character)

    return dict(
        center_mjy_sr=None if center is None else round(center, 4),
        peak_snr=peak_snr,
        flagged_mean=round(flagged_mean, 4),
        ir_character=ir_character,
        summary=" · ".join(summary_bits) if summary_bits else "No usable photometry yet.",
    )


def reproject_frame(hdul, out_wcs, shape):
    arr, _ = reproject_interp((clean_image(hdul), WCS(hdul["IMAGE"].header)), out_wcs,
                              shape_out=shape)
    return arr


def group_epochs(frames):
    """Split frames (sorted by mjd) into survey passes separated by > EPOCH_GAP_DAYS."""
    groups = []
    for f in sorted(frames, key=lambda f: f["mjd"]):
        if groups and f["mjd"] - groups[-1][-1]["mjd"] <= config.EPOCH_GAP_DAYS:
            groups[-1].append(f)
        else:
            groups.append([f])
    return groups


def stack(arrays):
    """Mean-combine background-subtracted frames, each scaled by its own noise (S/N stack)."""
    normed = []
    for a in arrays:
        if not np.isfinite(a).any():
            continue
        mad = np.nanmedian(np.abs(a - np.nanmedian(a))) * 1.4826
        normed.append(a / mad if mad > 0 else a)
    if not normed:
        return None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return np.nanmean(normed, axis=0)


def limits(arrays, lo=1.0, hi=99.7):
    vals = np.concatenate([a[np.isfinite(a)] for a in arrays if a is not None])
    return np.percentile(vals, [lo, hi]) if vals.size else (0.0, 1.0)


def fill_saturated(arr, passes=4):
    """Display only: flagged (mostly saturated) pixels take the brightest neighbour value."""
    a = arr.copy()
    for _ in range(passes):
        bad = ~np.isfinite(a)
        if not bad.any():
            break
        a[bad] = maximum_filter(np.where(bad, -np.inf, a), size=3)[bad]
    a[~np.isfinite(a)] = np.nan
    return a


def _asinh(arr, vmin, vmax):
    x = np.clip((np.nan_to_num(arr, nan=vmin) - vmin) / max(vmax - vmin, 1e-12), 0, 1)
    return np.arcsinh(x * 10) / np.arcsinh(10)


def to_png(arr, vmin=None, vmax=None, scale=4):
    if vmin is None:
        vmin, vmax = limits([arr])
    img = (_asinh(fill_saturated(arr), vmin, vmax) * 255).astype(np.uint8)[::-1]  # FITS y-up → PNG y-down
    return _encode(Image.fromarray(img, "L"), scale)


def reproject_frame_footprint(hdul, out_wcs, shape):
    """`reproject_frame`, the footprint mask (False where the frame does not reach), and the
    output pixels touched by an artifact flag (all False without a FLAGS extension).

    Coverage comes from the detector edges only; NaN pixels such as saturated star cores
    stay inside the footprint and are filled for display.
    """
    in_wcs = WCS(hdul["IMAGE"].header)
    arr, _ = reproject_interp((clean_image(hdul, bad_mask=0), in_wcs), out_wcs, shape_out=shape)
    edges = np.ones(hdul["IMAGE"].data.shape, dtype=float)
    _, footprint = reproject_interp((edges, in_wcs), out_wcs, shape_out=shape)
    flagged = np.zeros(shape, dtype=bool)
    if "FLAGS" in hdul:
        bad = (hdul["FLAGS"].data & ARTIFACT_MASK) != 0
        if bad.any():
            # Any interpolation weight from a flagged pixel counts: a cosmic ray must not
            # survive as a faint smudge in the neighbouring output pixels.
            spread, _ = reproject_interp((bad.astype(float), in_wcs), out_wcs, shape_out=shape)
            flagged = np.nan_to_num(spread) > 0
    return arr, footprint > 0, flagged


def to_png_alpha(arr, covered):
    """Like `to_png`, but pixels outside `covered` (the frame footprint) are transparent."""
    vmin, vmax = limits([arr])
    filled = fill_saturated(arr, passes=12)
    # Holes too wide to fill from neighbours are saturated cores: show them bright, not black.
    filled = np.where(covered & ~np.isfinite(filled), vmax, filled)
    grey = (_asinh(filled, vmin, vmax) * 255).astype(np.uint8)
    alpha = np.where(covered, 255, 0).astype(np.uint8)
    img = np.dstack([grey, alpha])[::-1]
    return _encode(Image.fromarray(img, "LA"), 1)


def diff_png(a, b, scale=4):
    d = np.nan_to_num(fill_saturated(b) - fill_saturated(a))
    lim = np.percentile(np.abs(d), 99.5) or 1.0
    img = ((np.clip(d / lim, -1, 1) + 1) * 127.5).astype(np.uint8)[::-1]
    return _encode(Image.fromarray(img, "L"), scale)


def all_diff_png(arrays, scale=4):
    """Single change photo from every survey-pass coadd: peak-to-peak (max − min).

    Bright = largest swing across the full set of passes; static sky goes dark.
    """
    if len(arrays) < 2:
        raise ValueError("Need at least two arrays to difference")
    cube = np.stack([fill_saturated(a) for a in arrays], axis=0)
    d = np.nan_to_num(np.nanmax(cube, axis=0) - np.nanmin(cube, axis=0))
    lim = np.percentile(d, 99.5) or 1.0
    img = (np.clip(d / lim, 0, 1) * 255).astype(np.uint8)[::-1]
    return _encode(Image.fromarray(img, "L"), scale)


def rgb_png(det_stacks, scale=4):
    """Short wavelengths → blue, long → red: B = D1+D2, G = D3+D4, R = D5+D6.

    Amateur loads often only bring D5–D6. In that case build a 2-band false color
    (R=D6, G=D5, B=mean) so RGB view is still useful beside those bands.
    """
    def channel(dets):
        parts = [det_stacks[d] for d in dets if det_stacks.get(d) is not None]
        if not parts:
            return None
        c = fill_saturated(np.nanmean(parts, axis=0))
        lo, hi = limits([c], 2, 99.8)
        return _asinh(c, lo, hi)

    r = channel((5, 6))
    g = channel((3, 4))
    b = channel((1, 2))
    if g is None and b is None and det_stacks.get(5) is not None and det_stacks.get(6) is not None:
        r = channel((6,))
        g = channel((5,))
        b = channel((5, 6))
    chans = [r, g, b]
    shape = next(c.shape for c in chans if c is not None)
    rgb = np.dstack([c if c is not None else np.zeros(shape) for c in chans])
    img = (rgb * 255).astype(np.uint8)[::-1]
    return _encode(Image.fromarray(img, "RGB"), scale)


def _encode(im, scale):
    if scale > 1:
        im = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def blink_gif(png_bytes_list, duration_ms=500):
    """Looping GIF from already-rendered PNG cutouts (survey-pass blink)."""
    if len(png_bytes_list) < 2:
        return None
    frames = []
    for raw in png_bytes_list:
        im = Image.open(io.BytesIO(raw))
        if im.mode not in ("RGB", "L", "P"):
            im = im.convert("RGB")
        frames.append(im)
    buf = io.BytesIO()
    frames[0].save(
        buf,
        format="GIF",
        save_all=True,
        append_images=frames[1:],
        duration=max(80, int(duration_ms)),
        loop=0,
        optimize=False,
        disposal=2,
    )
    return buf.getvalue()


def spectrum(cutouts, ra, dec, radius_px=1):
    """Flux at (ra, dec) in every frame, paired with that pixel's exact wavelength.

    Returns (points, n_rejected). A frame is rejected if any aperture pixel is flagged, since
    summing only the surviving pixels would report a falsely low flux (saturated stars).
    """
    pts, rejected = [], 0
    for meta, hdul in cutouts:
        w = WCS(hdul["IMAGE"].header)
        x, y = map(float, w.world_to_pixel_values(ra, dec))
        if not (np.isfinite(x) and np.isfinite(y)):
            continue
        xi, yi = int(round(x)), int(round(y))
        img = clean_image(hdul)
        ny, nx = img.shape
        if not (radius_px <= xi < nx - radius_px and radius_px <= yi < ny - radius_px):
            continue
        box = img[yi - radius_px:yi + radius_px + 1, xi - radius_px:xi + radius_px + 1]
        if not np.isfinite(box).all():
            rejected += 1
            continue
        try:
            ww = WCS(hdul["IMAGE"].header, fobj=hdul, key="W")
            lam, _ = ww.pixel_to_world_values(xi, yi)
            lam = float(lam)
        except Exception:
            lam = (meta["em_min_um"] + meta["em_max_um"]) / 2
        pts.append(dict(wavelength_um=round(lam, 4), flux=float(np.nansum(box)),
                        detector=meta["detector"], date=mjd_to_iso(meta["mjd"])))
    pts.sort(key=lambda p: p["wavelength_um"])
    return pts, rejected


def centroid(arr, col, row, r=3):
    """Refine a click to the light-weighted center of the source near (col, row) in array pixels.

    Returns (col, row, snr, refined). Falls back to the click when nothing stands out.
    """
    n_rows, n_cols = arr.shape
    c0, r0 = int(round(col)), int(round(row))
    lo_c, hi_c = max(0, c0 - r), min(n_cols, c0 + r + 1)
    lo_r, hi_r = max(0, r0 - r), min(n_rows, r0 + r + 1)
    box = arr[lo_r:hi_r, lo_c:hi_c]
    if box.size == 0 or not np.isfinite(box).any():
        return float(col), float(row), 0.0, False
    # Background and noise from a wider annulus-like window.
    wide = arr[max(0, r0 - 3 * r):r0 + 3 * r + 1, max(0, c0 - 3 * r):c0 + 3 * r + 1]
    bg = float(np.nanmedian(wide))
    noise = float(np.nanmedian(np.abs(wide - bg)) * 1.4826) or 1.0
    w = np.nan_to_num(box - bg, nan=0.0)
    snr = float(np.nanmax(w) / noise)
    w[w < 0] = 0
    if snr < 3 or w.sum() <= 0:
        return float(col), float(row), snr, False
    rr, cc = np.mgrid[lo_r:hi_r, lo_c:hi_c]
    return float((w * cc).sum() / w.sum()), float((w * rr).sum() / w.sum()), snr, True


def fit_motion(t_yr, xi, eta, sigma, t_pred):
    """Weighted linear fit of tangent-plane offsets (arcsec) against time (years).

    Returns velocities (arcsec/yr), predicted offsets, their 2x2 covariance and fit RMS.
    """
    t = np.asarray(t_yr, float)
    s = np.asarray(sigma, float)
    tm = float(np.average(t, weights=1 / s**2))  # pivot → uncorrelated intercept/slope
    A = np.column_stack([np.ones_like(t), t - tm]) / s[:, None]
    cov = np.linalg.inv(A.T @ A)  # same design for both axes
    out = {}
    resid = []
    for name, y in (("xi", np.asarray(xi, float)), ("eta", np.asarray(eta, float))):
        coef = cov @ A.T @ (y / s)
        out[name] = coef
        resid.append(y - (coef[0] + coef[1] * (t - tm)))
    resid = np.concatenate(resid)
    rms = float(np.sqrt(np.mean(resid**2)))
    # Scale formal errors up when the scatter is worse than the assumed per-point sigma.
    dof = max(1, 2 * len(t) - 4)
    chi2 = float(np.sum((resid / np.concatenate([s, s])) ** 2) / dof)
    scale = max(1.0, chi2)
    g = np.array([1.0, t_pred - tm])
    var_pred = float(g @ cov @ g) * scale
    return dict(
        v_xi=float(out["xi"][1]),
        v_eta=float(out["eta"][1]),
        v_err=float(np.sqrt(cov[1, 1] * scale)),
        xi_pred=float(out["xi"][0] + out["xi"][1] * (t_pred - tm)),
        eta_pred=float(out["eta"][0] + out["eta"][1] * (t_pred - tm)),
        pred_sigma=float(np.sqrt(var_pred)),
        rms=rms,
        chi2=chi2,
    )


def mjd_to_iso(mjd):
    return Time(mjd, format="mjd").iso[:10]


def mjd_to_year(mjd):
    return Time(mjd, format="mjd").jyear
