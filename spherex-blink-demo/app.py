"""FastAPI server: proxies IRSA (which has no CORS) and serves the web page."""
import asyncio
import base64
import hashlib
import math
import time
import traceback
import uuid
from collections import Counter, OrderedDict
from contextlib import asynccontextmanager
from pathlib import Path

import astropy.units as u
import numpy as np
from astropy.coordinates import SkyCoord, get_constellation
from astropy.io import fits
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import aws_sections
import config
import context_sky
import hips_preview
import irsa
import known_objects
import processing as P

app = FastAPI(title="SPHEREx Blink demo")
STATIC = Path(__file__).parent / "static"
JOBS = {}
# Finished jobs hold cutouts, stacks and PNGs in memory; keep only the most recent ones.
MAX_JOBS = 24


class LoadRequest(BaseModel):
    ra: float | None = None
    dec: float | None = None
    fov: float = 0.1
    preset: str | None = None
    name: str | None = None
    collections: list[str] = config.DEFAULT_COLLECTIONS
    # Empty = all detectors. Selecting fewer bands downloads much less from IRSA.
    detectors: list[int] = []
    max_frames: int | None = None
    force: bool = False


@app.get("/api/config")
def get_config():
    return {
        "collections": config.COLLECTIONS,
        "default_collections": config.DEFAULT_COLLECTIONS,
        "max_frames": config.MAX_FRAMES,
        "max_frames_cap": config.MAX_FRAMES_CAP,
        "detectors": [
            {"id": d, **meta} for d, meta in config.DETECTOR_BANDS.items()
        ],
        "presets": {
            k: {
                "name": v["name"],
                "fov": v["fov"],
                **dict(zip(("ra", "dec"), irsa.propagate(v, 2026.0))),
            }
            for k, v in config.PRESETS.items()
        },
    }


@app.get("/api/resolve")
async def resolve(name: str):
    try:
        t = await irsa.resolve_name(name)
    except irsa.NameResolveUnavailable as e:
        raise HTTPException(503, str(e)) from e
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(503, f"Name resolve failed: {type(e).__name__}: {e}") from e
    if not t:
        raise HTTPException(
            404,
            f"Unknown name “{name}”. Try NED / SIMBAD / Gaia names "
            "(e.g. M31, Deneb, Vega, Gaia DR3 2067480667201160704) "
            "or a challenge target name.",
        )
    ra, dec = irsa.propagate(t, 2026.0)
    return {**t, "ra_2026": ra, "dec_2026": dec}


@app.post("/api/load")
async def load(req: LoadRequest):
    target = None
    if req.preset:
        preset = config.PRESETS.get(req.preset)
        if not preset:
            raise HTTPException(400, "Unknown preset")
        target = {**preset, "resolver": "preset"}
    elif req.name:
        target = await irsa.resolve_name(req.name)
        if not target:
            raise HTTPException(404, "Name not resolved; enter RA/Dec instead")
    elif req.ra is not None and req.dec is not None:
        target = await irsa.resolve_position(float(req.ra), float(req.dec))
    else:
        raise HTTPException(400, "Give a preset, a name, or ra+dec")
    fov = float(np.clip(req.fov, 0.03, 3.5))
    colls = [c for c in req.collections if c in config.COLLECTIONS] or config.DEFAULT_COLLECTIONS
    dets = sorted({int(d) for d in req.detectors if 1 <= int(d) <= 6})
    # 0 / omitted-with-default-0 → every cutout. Positive → thinned sample.
    raw_max = config.MAX_FRAMES if req.max_frames is None else int(req.max_frames)
    # Allow small samples (gallery wants 2–4 cutouts); 0 still means “all frames”.
    max_frames = 0 if raw_max <= 0 else int(np.clip(raw_max, 2, config.MAX_FRAMES_CAP))
    key = hashlib.sha1(
        repr((target["ra"], target["dec"], fov, colls, dets, max_frames)).encode()
    ).hexdigest()[:12]
    existing = JOBS.get(key)
    # Drop abandoned / hung searches (IRSA can stall on SIA) and cutout hangs.
    stale = (
        existing is not None
        and existing["status"] in ("searching", "downloading", "processing")
        and (time.time() - existing.get("started", 0)) > 45
    )
    # Reuse in-flight / finished jobs unless forced or the previous run went stale.
    reuse = (
        existing is not None
        and not req.force
        and not stale
        and existing["status"] in ("searching", "downloading", "processing", "done")
    )
    if not reuse:
        _evict_old_jobs(keep=key)
        run_id = uuid.uuid4().hex
        JOBS[key] = {
            "status": "searching",
            "done": 0,
            "total": 0,
            "attempt": 0,
            "message": "Connecting to IRSA…",
            "pngs": {},
            "started": time.time(),
            "run_id": run_id,
        }
        asyncio.create_task(run_job(key, target, fov, colls, dets, max_frames, run_id))
    return {"job": key}


@app.get("/api/job/{key}")
def job_status(key: str):
    j = _job(key)
    return {k: v for k, v in j.items()
            if k in ("status", "done", "total", "attempt", "message", "error", "result")}


# A band with fewer usable downloads than this gets a second try with its other frames.
BACKFILL_MIN_PER_BAND = 2


async def run_job(key, target, fov, colls, dets, max_frames, run_id):
    job = JOBS[key]

    def active():
        return JOBS.get(key, {}).get("run_id") == run_id

    desc_task: asyncio.Task | None = None
    try:
        # Center on where the target is around the middle of the SPHEREx mission (moving stars!).
        ra0, dec0 = irsa.propagate(target, 2026.0)
        # Object blurb while IRSA work runs (Wikipedia when the name is known).
        desc_task = asyncio.create_task(irsa.describe_target(target))

        def on_attempt(attempt: int, message: str | None = None):
            if active():
                job.update(
                    status="searching",
                    attempt=attempt,
                    message=message or f"Waiting on IRSA archive… attempt {attempt}",
                )

        search_report: dict = {}
        rows = await irsa.search(ra0, dec0, colls, on_attempt=on_attempt, report=search_report)
        if not active():
            return
        if not rows:
            job.update(status="error", error="No SPHEREx images cover this position in "
                       f"{', '.join(colls)}. Coverage is still filling in — try another release "
                       "or a challenge preset (e.g. Barnard's Star).")
            return
        rows = irsa.filter_detectors(rows, dets)
        if not rows:
            wanted = ", ".join(f"D{d}" for d in dets) or "selected detectors"
            job.update(
                status="error",
                error=f"No SPHEREx frames for {wanted} at this position. "
                      "Try other detectors or both QR releases.",
            )
            return
        frames = rows if max_frames <= 0 else irsa.sample_frames(rows, max_frames)
        det_note = (
            f" · detectors {', '.join(f'D{d}' for d in dets)}" if dets else ""
        )
        thin_note = "" if max_frames <= 0 or len(frames) == len(rows) else f" (sampled from {len(rows)})"
        job.update(
            status="downloading",
            total=len(frames),
            found=len(rows),
            done=0,
            message=f"Downloading {len(frames)} cutouts from IRSA{thin_note}{det_note}…",
        )

        async def fetch(f):
            try:
                h = await irsa.get_cutout(f["url"], ra0, dec0, fov * 1.45)  # margin for rotation
            except Exception:
                h = None
            job["done"] += 1
            job["message"] = (
                f"Downloading cutouts from IRSA… {job['done']}/{job['total']}"
                f"{det_note}"
            )
            return f, h

        # Per-cutout deadlines (in irsa.get_cutout) so one hung IRSA response cannot
        # freeze the bar at e.g. 23/24. Failed frames are skipped.
        tasks = [asyncio.create_task(fetch(f)) for f in frames]
        cutouts = []
        for task in asyncio.as_completed(tasks):
            try:
                f, h = await task
            except Exception:
                continue
            if h is not None:
                cutouts.append((f, h))
        if not active():
            return

        # Backfill: when every sampled frame of a band failed (IRSA timeouts), try that band's
        # other frames, so one slow batch doesn't hide a whole wavelength band.
        tried = {f["url"] for f in frames}
        have = Counter(f["detector"] for f, _ in cutouts)
        extra = []
        for d in sorted({r["detector"] for r in rows}):
            need = BACKFILL_MIN_PER_BAND - have[d]
            spare = [r for r in rows if r["detector"] == d and r["url"] not in tried]
            if need <= 0 or not spare:
                continue
            n = min(len(spare), need * 2)
            step = len(spare) / n
            extra += [spare[int(i * step)] for i in range(n)]
        if extra:
            short = sorted({f["detector"] for f in extra})
            job["total"] += len(extra)
            job["message"] = f"Retrying {', '.join(f'D{d}' for d in short)} with other frames…"
            for f, h in await asyncio.gather(*(fetch(f) for f in extra)):
                if h is not None:
                    cutouts.append((f, h))
            if not active():
                return
        job["band_rows"] = {
            "wanted": dets or list(range(1, 7)),
            "found": Counter(r["detector"] for r in rows),
            "downloaded": Counter(f["detector"] for f, _ in cutouts),
        }

        if not cutouts:
            job.update(status="error",
                       error="IRSA returned image IDs but every cutout download failed or timed out. "
                             "The archive is often slow — retry in a minute.")
            return
        skipped = max(0, job["total"] - len(cutouts))
        job.update(
            status="processing",
            done=job["total"],
            message=(
                f"Aligning {len(cutouts)} frames…"
                + (f" ({skipped} cutouts timed out, skipped)" if skipped else "")
            ),
        )
        result = await asyncio.to_thread(build, job, target, ra0, dec0, fov, cutouts, len(rows))
        if not active():
            return
        description = ""
        if desc_task is not None:
            try:
                description = await desc_task
            except Exception:
                description = ""
        if not description:
            description = irsa.catalog_blurb(target)
        if description:
            result.setdefault("target", {})["description"] = description
        # Releases IRSA never answered for: their (older) survey passes are missing.
        result["missing_releases"] = search_report.get("missing") or []
        job.update(status="done", result=result, cutouts=cutouts, ra0=ra0, dec0=dec0, fov=fov)
    except irsa.IrsaUnavailable as e:
        traceback.print_exc()
        if active():
            job.update(status="error", error=str(e))
    except Exception as e:
        traceback.print_exc()
        if active():
            job.update(status="error", error=f"{type(e).__name__}: {e}")
    finally:
        if desc_task is not None and not desc_task.done():
            desc_task.cancel()


def build(job, target, ra0, dec0, fov, cutouts, n_found):
    w, shape = P.target_wcs(ra0, dec0, fov)
    job["wcs"] = w
    pngs = job["pngs"]
    reproj = [(m, h, P.reproject_frame(h, w, shape)) for m, h in cutouts]
    reproj = [r for r in reproj if np.isfinite(r[2]).mean() > 0.3]
    # Why a band is (or isn't) on the stage: frames in the archive → downloaded → usable here.
    rows_info = job.get("band_rows") or {}
    used = Counter(m["detector"] for m, _, _ in reproj)
    band_coverage = [
        dict(detector=d,
             found=int(rows_info.get("found", {}).get(d, 0)),
             downloaded=int(rows_info.get("downloaded", {}).get(d, 0)),
             used=int(used[d]))
        for d in rows_info.get("wanted", range(1, 7))
    ]
    # Cutouts arrive in download-completion order; frames and survey passes need time order.
    reproj.sort(key=lambda r: r[0]["mjd"])

    # 1) Individual frames, in time order (each has its own stretch: wavelengths differ).
    frames_out = []
    for i, (m, h, arr) in enumerate(reproj):
        pngs[f"f{i}"] = P.to_png(arr)
        frames_out.append(dict(
            png=f"f{i}",
            date=P.mjd_to_iso(m["mjd"]),
            detector=m["detector"],
            band=f"{m['em_min_um']:.2f}–{m['em_max_um']:.2f} µm",
            collection=m["collection"],
            obs_id=m["obs_id"],
            flagged=round(P.flag_fraction(h), 3),
            flags=P.flag_breakdown(h),
        ))

    # 2) Survey-pass stacks (all detectors added → best S/N), shared stretch so blinking is fair.
    groups = P.group_epochs([dict(m, _arr=a) for m, _, a in reproj])
    stacks = [P.stack([g["_arr"] for g in grp]) for grp in groups]
    keep = [(g, s) for g, s in zip(groups, stacks) if s is not None]
    job["epoch_stacks"] = [s for _, s in keep]
    job["epoch_mjd"] = [float(np.mean([g["mjd"] for g in grp])) for grp, _ in keep]
    job["target_full"] = target
    vmin, vmax = P.limits([s for _, s in keep])
    epochs_out = []
    for i, (grp, s) in enumerate(keep):
        pngs[f"e{i}"] = P.to_png(s, vmin, vmax)
        mid = float(np.mean([g["mjd"] for g in grp]))
        # expected target position at this epoch (from proper motion), in grid pixels
        tra, tdec = irsa.propagate(target, P.mjd_to_year(mid))
        x, y = w.world_to_pixel_values(tra, tdec)
        epochs_out.append(dict(png=f"e{i}", start=P.mjd_to_iso(grp[0]["mjd"]),
                               end=P.mjd_to_iso(grp[-1]["mjd"]), n=len(grp),
                               target_px=[float(x), float(shape[0] - 1 - y)]))

    # 3) Per-detector stacks (all times) + RGB composite.
    det_stacks, det_out = {}, []
    for d in range(1, 7):
        arrs = [a for m, _, a in reproj if m["detector"] == d]
        s = P.stack(arrs) if arrs else None
        det_stacks[d] = s
        if s is not None:
            pngs[f"d{d}"] = P.to_png(s)
            band = next(m for m, _, _ in reproj if m["detector"] == d)
            det_out.append(dict(png=f"d{d}", detector=d, n=len(arrs),
                                band=f"{band['em_min_um']:.2f}–{band['em_max_um']:.2f} µm"))
    if any(v is not None for v in det_stacks.values()):
        pngs["rgb"] = P.rgb_png(det_stacks)

    photo = P.photo_stats(reproj, det_stacks, shape)

    return dict(
        target=irsa.target_public(target, ra0, dec0),
        photo=photo,
        fov=fov,
        npix=shape[0],
        n_found=n_found,
        n_used=len(reproj),
        frames=frames_out,
        epochs=epochs_out,
        detectors=det_out,
        band_coverage=band_coverage,
        rgb="rgb" if "rgb" in pngs else None,
        pixel_scale=config.PIXEL_SCALE_ARCSEC,
        contam_bits=list(config.CONTAM_FLAG_BITS.keys()),
    )


def _evict_old_jobs(keep=None):
    """Drop the oldest jobs beyond MAX_JOBS (dicts keep insertion order)."""
    while len(JOBS) >= MAX_JOBS:
        oldest = next((k for k in JOBS if k != keep), None)
        if oldest is None:
            break
        old = JOBS.pop(oldest)
        for _, hdul in old.get("cutouts") or []:
            try:
                hdul.close()
            except Exception:
                pass


def _job(key):
    if key not in JOBS:
        raise HTTPException(404, "Unknown job")
    return JOBS[key]


@app.get("/api/job/{key}/png/{name}")
def png(key: str, name: str):
    data = _job(key)["pngs"].get(name)
    if data is None:
        raise HTTPException(404)
    return Response(data, media_type="image/png", headers={"Cache-Control": "max-age=3600"})


@app.get("/api/job/{key}/diff")
def diff(
    key: str,
    a: int = Query(0, ge=0),
    b: int | None = Query(None, ge=0),
    mode: str = Query("span", pattern="^(span|pair)$"),
):
    """Difference image from survey-pass coadds (the general blink photos).

    mode=span (default): single photo — peak-to-peak change across every pass.
    mode=pair: pass ``b`` minus pass ``a`` (kept for tooling).
    """
    st = [s for s in (_job(key).get("epoch_stacks") or []) if s is not None]
    if len(st) < 2:
        raise HTTPException(400, "Need at least two survey passes to difference")
    if mode == "pair":
        if not (0 <= a < len(st)) or b is None or not (0 <= b < len(st)):
            raise HTTPException(400, "Pair mode needs valid a and b indices")
        # diff_png(a, b) → b − a
        return Response(P.diff_png(st[a], st[b]), media_type="image/png")
    # Single general difference from all survey-pass coadds.
    return Response(P.all_diff_png(st), media_type="image/png")


@app.get("/api/job/{key}/spectrum")
def spectrum(key: str, x: float = Query(...), y: float = Query(...)):
    """x, y: pixel in the displayed grid (origin top-left)."""
    j = _job(key)
    if j["status"] != "done":
        raise HTTPException(409, "Job not finished")
    n = j["result"]["npix"]
    ra, dec = j["wcs"].pixel_to_world_values(x, n - 1 - y)
    points, rejected = P.spectrum(j["cutouts"], float(ra), float(dec))
    return {"ra": float(ra), "dec": float(dec), "points": points, "rejected": rejected}


class TrackMark(BaseModel):
    epoch: int
    x: float
    y: float


class PredictRequest(BaseModel):
    marks: list[TrackMark]
    horizon_days: float = 182.6


@app.post("/api/job/{key}/predict")
def predict(key: str, req: PredictRequest):
    """Fit linear sky motion through user marks (one per survey pass) and extrapolate.

    x, y: pixel in the displayed grid (origin top-left), like /spectrum.
    """
    j = _job(key)
    stacks, mjds = _motion_inputs(j)
    by_epoch = {}
    for m in req.marks:
        if not 0 <= m.epoch < len(stacks):
            raise HTTPException(400, f"Unknown visit {m.epoch}")
        by_epoch[m.epoch] = m  # last click on a visit wins
    if len(by_epoch) < 3:
        raise HTTPException(400, "Mark the object in at least 3 different visits")
    n = j["result"]["npix"]
    points = []
    for ep in sorted(by_epoch, key=lambda e: mjds[e]):
        m = by_epoch[ep]
        col, row, snr, refined = P.centroid(P.fill_saturated(stacks[ep]), m.x, n - 1 - m.y)
        points.append(dict(epoch=ep, col=col, row=row, snr=snr, refined=refined))
    return _motion_fit(j, points, req.horizon_days)


def _motion_inputs(j):
    if j["status"] != "done":
        raise HTTPException(409, "Job not finished")
    stacks, mjds = j.get("epoch_stacks"), j.get("epoch_mjd")
    if not stacks or not mjds:
        raise HTTPException(409, "Reload this target: the job predates motion tracking")
    return stacks, mjds


def _motion_fit(j, points, horizon_days):
    """Fit straight-line sky motion through per-pass positions (array pixels) and extrapolate.

    points: [{epoch, col, row, snr, refined}], one per survey pass. Shared by hand marks
    (/predict) and the automatic mover search (/movers).
    """
    mjds, w = j["epoch_mjd"], j["wcs"]
    horizon = float(np.clip(horizon_days, 1, 3650))
    n = j["result"]["npix"]
    scale = config.PIXEL_SCALE_ARCSEC

    marks = []
    for pt in sorted(points, key=lambda q: mjds[q["epoch"]]):
        ep, col, row = pt["epoch"], pt["col"], pt["row"]
        ra, dec = w.pixel_to_world_values(col, row)
        marks.append(dict(epoch=ep, mjd=mjds[ep], date=P.mjd_to_iso(mjds[ep]),
                          x=float(col), y=float(n - 1 - row), ra=float(ra), dec=float(dec),
                          snr=round(float(pt["snr"]), 1), refined=bool(pt["refined"])))

    # Tangent plane around the first mark, arcsec (xi east, eta north).
    ref = SkyCoord(marks[0]["ra"] * u.deg, marks[0]["dec"] * u.deg)
    frame = ref.skyoffset_frame()
    pts = SkyCoord([m["ra"] for m in marks] * u.deg, [m["dec"] for m in marks] * u.deg)
    off = pts.transform_to(frame)
    xi = off.lon.to_value(u.arcsec)
    eta = off.lat.to_value(u.arcsec)
    t = np.array([P.mjd_to_year(m["mjd"]) for m in marks])
    # Position precision: measured for automatic detections; for clicks ~0.3 px with a clean
    # centroid, ~1 px for a bare click.
    by_ep = {pt["epoch"]: pt for pt in points}
    sigma = np.array([
        (by_ep[m["epoch"]].get("sigma_px") or (0.3 if m["refined"] else 1.0)) * scale for m in marks
    ])
    # "In 6 months" means from today (or from the last pass, if that were ever later).
    today_mjd = time.time() / 86400.0 + 40587.0
    pred_mjd = max(marks[-1]["mjd"], today_mjd) + horizon
    t_pred = P.mjd_to_year(pred_mjd)
    fit = P.fit_motion(t, xi, eta, sigma, t_pred)

    p = SkyCoord(fit["xi_pred"] * u.arcsec, fit["eta_pred"] * u.arcsec, frame=frame).icrs
    pra, pdec = float(p.ra.deg), float(p.dec.deg)
    px, py = w.world_to_pixel_values(pra, pdec)
    x_disp, y_disp = float(px), float(n - 1 - py)
    in_view = -0.5 <= x_disp <= n - 0.5 and -0.5 <= y_disp <= n - 0.5

    speed = math.hypot(fit["v_xi"], fit["v_eta"])
    pa = (math.degrees(math.atan2(fit["v_xi"], fit["v_eta"])) + 360) % 360  # east of north
    span_px = speed * (t[-1] - t[0]) / scale
    notes = []
    if span_px < 0.7:
        notes.append("The marks moved less than a pixel: motion is too small to measure reliably here.")
    if fit["rms"] > 1.5 * scale:
        notes.append("Marks don't line up on a straight path: maybe a mis-click, a different "
                     "source, or a solar-system object whose path curves.")
    weak = [m for m in marks if not m["refined"]]
    if weak:
        notes.append(f"{len(weak)} mark(s) had no clear source nearby; used the click position.")
    if not notes:
        notes.append("Clean straight-line fit.")

    catalog = None
    target = j.get("target_full") or {}
    if target.get("pm_ra") or target.get("pm_dec"):
        cra, cdec = irsa.propagate(target, t_pred)
        sep = SkyCoord(cra * u.deg, cdec * u.deg).separation(p).arcsec
        catalog = dict(ra=float(cra), dec=float(cdec), separation_arcsec=round(float(sep), 2),
                       pm_ra=target.get("pm_ra"), pm_dec=target.get("pm_dec"))

    return dict(
        marks=marks,
        pm_ra_cosdec=round(fit["v_xi"] * 1000, 1),   # mas/yr
        pm_dec=round(fit["v_eta"] * 1000, 1),
        pm_err=round(fit["v_err"] * 1000, 1),
        speed_arcsec_yr=round(speed, 3),
        position_angle=round(pa, 1),
        rms_arcsec=round(fit["rms"], 2),
        prediction=dict(
            date=P.mjd_to_iso(pred_mjd),
            mjd=pred_mjd,
            ra=pra,
            dec=pdec,
            x=x_disp,
            y=y_disp,
            in_view=bool(in_view),
            sigma_arcsec=round(fit["pred_sigma"], 2),
            sigma_px=round(fit["pred_sigma"] / scale, 2),
        ),
        catalog=catalog,
        notes=notes,
    )


@app.get("/api/job/{key}/movers")
async def movers(key: str, horizon_days: float = Query(182.6, ge=1, le=3650)):
    """Moving objects in the field, from catalogs (no clicks needed).

    Stars: Gaia DR3 proper motions (plus the loaded target's own catalog motion, which
    covers faint brown dwarfs Gaia can't see). Asteroids: IMCCE SkyBoT for each survey
    pass, with JPL Horizons for the position 6 months ahead. Each star is then checked
    against the SPHEREx images: is there a source at its catalog position in each pass?
    """
    j = _job(key)
    stacks, mjds = _motion_inputs(j)
    cached = j.get("movers_cache")
    if cached and cached[0] == horizon_days:
        return cached[1]
    w, res = j["wcs"], j["result"]
    n, fov = res["npix"], res["fov"]
    scale = config.PIXEL_SCALE_ARCSEC
    center = (res["target"]["ra"], res["target"]["dec"])
    radius = fov * 0.75  # covers the corners of the square field
    years = [P.mjd_to_year(m) for m in mjds]
    today_mjd = time.time() / 86400.0 + 40587.0
    pred_mjd = max(mjds[-1], today_mjd) + float(horizon_days)
    pred_year = P.mjd_to_year(pred_mjd)
    filled = [P.fill_saturated(s) for s in stacks]
    target = j.get("target_full") or {}
    notes: list[str] = []

    def to_px(ra, dec):
        col, row = w.world_to_pixel_values(ra, dec)
        col, row = float(col), float(row)
        return col, row, -0.5 <= col <= n - 0.5 and -0.5 <= row <= n - 0.5

    def pa_of(east, north):
        return (math.degrees(math.atan2(east, north)) + 360) % 360

    def star_candidate(obj, name, source, gmag=None):
        marks, offsets = [], []
        for e, (mjd, yr) in enumerate(zip(mjds, years)):
            ra, dec = irsa.propagate(obj, yr)
            col, row, inside = to_px(ra, dec)
            if not inside:
                continue
            # SPHEREx check: a source within a pixel of where the catalog puts the star.
            c2, r2, snr, ok = P.centroid(filled[e], col, row)
            seen = ok and math.hypot(c2 - col, r2 - row) <= 1.0
            if seen:
                offsets.append(math.hypot(c2 - col, r2 - row) * scale)
            marks.append(dict(epoch=e, mjd=mjd, date=P.mjd_to_iso(mjd), x=col, y=n - 1 - row,
                              ra=float(ra), dec=float(dec), snr=round(float(snr), 1), refined=bool(seen)))
        if not marks:
            return None
        pra, pdec = irsa.propagate(obj, pred_year)
        pcol, prow, pin = to_px(pra, pdec)
        speed = math.hypot(obj["pm_ra"], obj["pm_dec"]) / 1000  # arcsec/yr
        e_pm = float(obj.get("e_pm") or 0) / 1000
        sigma = max(0.01, e_pm * abs(pred_year - obj.get("ref_epoch", 2016.0)))
        shift_px = speed * (years[-1] - years[0]) / scale
        seen_n = sum(m["refined"] for m in marks)
        c_notes = [f"{source}: moves {speed:.2f}″/yr"
                   + (f", G = {gmag:.1f} mag" if gmag is not None else "") + "."]
        if seen_n:
            c_notes.append(f"SPHEREx sees a source at the catalog position in {seen_n} of {len(marks)} passes.")
        else:
            c_notes.append("Too faint (or blended) for SPHEREx to pick out here; the path is from the catalog.")
        if shift_px < 0.5:
            c_notes.append("Moves less than half a SPHEREx pixel across these passes, so the blink barely shows it.")
        return dict(
            name=name, source=source, kind="star",
            marks=marks,
            pm_ra_cosdec=round(obj["pm_ra"], 1), pm_dec=round(obj["pm_dec"], 1),
            pm_err=round(float(obj.get("e_pm") or 0), 2),
            speed_arcsec_yr=round(speed, 3), speed_label=f"{speed:.2f}″/yr",
            position_angle=round(pa_of(obj["pm_ra"], obj["pm_dec"]), 1),
            rms_arcsec=round(float(np.sqrt(np.mean(np.square(offsets)))) if offsets else 0.0, 2),
            prediction=dict(date=P.mjd_to_iso(pred_mjd), mjd=pred_mjd, ra=float(pra), dec=float(pdec),
                            x=pcol, y=n - 1 - prow, in_view=bool(pin),
                            sigma_arcsec=round(sigma, 3), sigma_px=round(sigma / scale, 3)),
            catalog=None, notes=c_notes,
            confirmed=seen_n >= 2, seen_passes=seen_n, shift_px=round(shift_px, 2),
            significance=round(speed * 1000 / max(float(obj.get("e_pm") or 0), 0.01), 0),
            snr=max((m["snr"] for m in marks), default=0.0),
        )

    async def stars():
        try:
            # ≥ 0.1″/yr: slower stars don't visibly move at SPHEREx resolution.
            return await irsa.gaia_movers(center[0], center[1], radius, min_pm_mas=100)
        except Exception as e:
            notes.append(f"Gaia catalog unavailable right now ({type(e).__name__}).")
            return []

    async def asteroids():
        found = {}
        per_pass = await asyncio.gather(
            *(irsa.skybot_asteroids(center[0], center[1], radius, mjd + 2400000.5) for mjd in mjds),
            return_exceptions=True,
        )
        if all(isinstance(r, Exception) for r in per_pass):
            notes.append(f"Asteroid service unavailable right now ({type(per_pass[0]).__name__}).")
            return []
        for e, (mjd, rows) in enumerate(zip(mjds, per_pass)):
            if isinstance(rows, Exception):
                continue
            for a in rows:
                col, row, inside = to_px(a["ra"], a["dec"])
                if inside:
                    found.setdefault(a["name"], (a, []))[1].append(dict(
                        epoch=e, mjd=mjd, date=P.mjd_to_iso(mjd), x=col, y=n - 1 - row,
                        ra=a["ra"], dec=a["dec"], snr=0.0, refined=False))
        out = []
        picked = list(found.items())[:5]
        positions = await asyncio.gather(
            *(irsa.horizons_position(name, pred_mjd + 2400000.5) for name, _ in picked),
            return_exceptions=True,
        )
        for (name, (a, marks)), pos in zip(picked, positions):
            if pos is None or isinstance(pos, Exception):
                continue
            pcol, prow, pin = to_px(*pos)
            rate = math.hypot(a["dra_arcsec_h"], a["ddec_arcsec_h"])
            out.append(dict(
                name=name, source="SkyBoT + JPL Horizons", kind="asteroid", marks=marks,
                pm_ra_cosdec=round(a["dra_arcsec_h"] * 8766e3, 0), pm_dec=round(a["ddec_arcsec_h"] * 8766e3, 0),
                pm_err=0.0, speed_arcsec_yr=round(rate * 8766, 0), speed_label=f"{rate:.0f}″/hour",
                position_angle=round(pa_of(a["dra_arcsec_h"], a["ddec_arcsec_h"]), 1), rms_arcsec=0.0,
                prediction=dict(date=P.mjd_to_iso(pred_mjd), mjd=pred_mjd, ra=pos[0], dec=pos[1],
                                x=pcol, y=n - 1 - prow, in_view=bool(pin), sigma_arcsec=1.0,
                                sigma_px=round(1.0 / scale, 3)),
                catalog=None,
                notes=[f"Asteroid ({a['kind']}, V ≈ {a['vmag']} mag), in the field during "
                       f"{len(marks)} of {len(mjds)} passes.",
                       "Asteroids orbit the Sun, so in 6 months it is far from this field: "
                       "the position comes from JPL Horizons, not a straight line.",
                       "It moves during each pass, so SPHEREx shows it smeared or not at all."],
                confirmed=False, seen_passes=0, shift_px=0.0, significance=0.0,
                snr=0.0,
            ))
        return out

    gaia, rocks = await asyncio.gather(stars(), asteroids())

    candidates = []
    t_ra, t_dec = (irsa.propagate(target, 2016.0) if target.get("ra") is not None else (None, None))
    target_matched = False
    for star in gaia:
        is_target = t_ra is not None and math.hypot(
            (star["ra"] - t_ra) * math.cos(math.radians(star["dec"])), star["dec"] - t_dec) * 3600 < 5
        name = (target.get("name") if is_target else None) or f"Gaia DR3 {star['source_id']}"
        c = star_candidate(star, name, "Gaia DR3", star["gmag"])
        if c:
            c["is_target"] = bool(is_target)
            target_matched |= bool(is_target)
            candidates.append(c)
    # The loaded target's own catalog motion (e.g. brown dwarfs too faint for Gaia).
    if not target_matched and (target.get("pm_ra") or target.get("pm_dec")) and \
            math.hypot(target.get("pm_ra") or 0, target.get("pm_dec") or 0) >= 30:
        obj = dict(target, pm_ra=target.get("pm_ra") or 0.0, pm_dec=target.get("pm_dec") or 0.0)
        c = star_candidate(obj, target.get("name") or "Target", "Target catalog")
        if c:
            c["is_target"] = True
            candidates.append(c)
    for a in rocks:
        a["is_target"] = False
        candidates.append(a)

    # Target first, then the stars that move most across the passes, then asteroids.
    candidates.sort(key=lambda c: (not c["is_target"], c["kind"] != "star", -c["shift_px"]))
    candidates = candidates[:10]
    for i, c in enumerate(candidates):
        c["id"] = i
    if not candidates and not notes:
        notes.append("No catalogued star here moves faster than 0.1″/yr, and no known asteroid "
                     "crossed the field during these passes.")
    missing = res.get("missing_releases") or []
    if missing:
        notes.append(f"IRSA didn't answer for {', '.join(missing)} this time, so some survey passes "
                     "are missing. Load again to fetch them.")
    out = dict(candidates=candidates, passes=len(mjds), notes=notes)
    if not any("unavailable" in m for m in notes):
        j["movers_cache"] = (horizon_days, out)
    return out


@app.get("/api/job/{key}/fits.zip")
def fits_zip(key: str):
    """Expert download: all cutouts used for this job as a ZIP of FITS files."""
    import io
    import zipfile

    j = _job(key)
    if j["status"] != "done":
        raise HTTPException(409, "Job not finished")
    cutouts = j.get("cutouts") or []
    if not cutouts:
        raise HTTPException(404, "No cutouts available for download")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as zf:
        for i, (meta, hdul) in enumerate(cutouts):
            bio = io.BytesIO()
            hdul.writeto(bio, overwrite=True)
            obs = str(meta.get("obs_id", "frame")).replace("/", "_")
            name = f"{i:03d}_{obs}_D{meta.get('detector', 0)}.fits"
            zf.writestr(name, bio.getvalue())
    return Response(
        buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="spherex_{key}_fits.zip"'},
    )


def _blink_png_frames(job: dict) -> list[bytes]:
    """Prefer survey-pass stacks (Flicker), then individual cutouts, then rebuild from arrays."""
    pngs = job.get("pngs") or {}
    result = job.get("result") or {}

    epochs = result.get("epochs") or []
    frames = [pngs[ep["png"]] for ep in epochs if ep.get("png") in pngs]
    if len(frames) >= 2:
        return frames

    cutout_frames = result.get("frames") or []
    frames = [pngs[f["png"]] for f in cutout_frames if f.get("png") in pngs]
    if len(frames) >= 2:
        return frames

    stacks = [s for s in (job.get("epoch_stacks") or []) if s is not None]
    if len(stacks) >= 2:
        vmin, vmax = P.limits(stacks)
        return [P.to_png(s, vmin, vmax) for s in stacks]

    return frames


@app.get("/api/job/{key}/blink.gif")
def blink_gif(key: str, duration_ms: int = Query(500, ge=80, le=2000)):
    """Looping GIF of survey-pass stacks — the same frames the Flicker control steps through."""
    j = _job(key)
    if j["status"] != "done":
        raise HTTPException(409, "Job not finished")
    frames = _blink_png_frames(j)
    if len(frames) < 2:
        raise HTTPException(
            404,
            "Need at least two images for a blink GIF. Re-lock the target if the API just restarted.",
        )
    data = P.blink_gif(frames, duration_ms=duration_ms)
    if not data:
        raise HTTPException(500, "GIF encode failed")
    return Response(
        data,
        media_type="image/gif",
        headers={"Content-Disposition": f'attachment; filename="spherex_{key}_blink.gif"'},
    )


# 1×1 transparent PNG for cells with no coverage. IRSA failures return 503 so the page retries.
_BLANK_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)
_MAP_TILES = config.CACHE_DIR / "map-tiles"
# Frames are rotated against the north-up cell; a √2-wide cutout still reaches its corners.
_MAP_CUTOUT_PAD = 1.45
# When one frame's edge crosses the cell, fill from up to this many frames in total.
_MAP_MAX_FRAMES = 4
_MAP_SEARCHES = 3
_MAP_FULL_COVERAGE = 0.999
# Concurrent IRSA tile builds. Waiting builds run newest-request-first: the cells the
# page is showing now beat cells it panned past, which keep building for the cache.
_MAP_SLOTS = 10
_map_active = 0
_map_waiting: list[tuple[str, asyncio.Future]] = []
_map_stamp: dict[str, float] = {}
# Prefetch requests rank below anything the page is showing.
_PREFETCH_PENALTY_S = 300.0


def _stamp_map_tile(digest: str, prefetch: bool):
    stamp = time.monotonic() - (_PREFETCH_PENALTY_S if prefetch else 0.0)
    _map_stamp[digest] = max(stamp, _map_stamp.get(digest, -math.inf))


@asynccontextmanager
async def _map_slot(digest: str):
    global _map_active
    if _map_active < _MAP_SLOTS:
        _map_active += 1
    else:
        fut = asyncio.get_running_loop().create_future()
        _map_waiting.append((digest, fut))
        await fut  # the releasing build hands its slot over
    try:
        yield
    finally:
        if _map_waiting:
            pick = max(
                range(len(_map_waiting)),
                key=lambda i: _map_stamp.get(_map_waiting[i][0], -math.inf),
            )
            _, nxt = _map_waiting.pop(pick)
            nxt.set_result(None)
        else:
            _map_active -= 1


def snap_map_cell(ra: float, dec: float, size: float):
    """Grid snap shared with the sky-map page. RA step shrinks by cos(dec)."""
    size = round(float(np.clip(size, 0.03, 1.5)), 6)
    dec_s = round(round(dec / size) * size, 6)
    dec_s = float(min(89.0, max(-89.0, dec_s)))
    cos = max(0.2, abs(math.cos(math.radians(dec_s))))
    ra_step = size / cos
    ra_s = round(round(ra / ra_step) * ra_step, 6) % 360.0
    if ra_s < 0:
        ra_s += 360.0
    return ra_s, dec_s, size, ra_step


@app.get("/api/map/tile")
async def map_tile(
    ra: float = Query(...),
    dec: float = Query(..., ge=-90, le=90),
    size: float = Query(..., gt=0, le=2),
    detector: int = Query(2, ge=1, le=6),
    collection: str = Query("spherex_dr1"),
    prefetch: bool = Query(False),
    epoch: str = Query("any", pattern="^(any|first|last)$"),
):
    """One north-up SPHEREx PNG for a sky-map cell. Cached on disk after the first IRSA fetch.

    epoch=first/last builds the cell only from its earliest/latest survey pass, so two tiles
    of the same cell can be blinked or overlaid to show what moved. The pass dates come back
    in the X-Map-Dates header ("start/end").
    """
    if collection not in config.COLLECTIONS:
        raise HTTPException(400, "Unknown collection")
    ra_s, dec_s, size_s, _ra_step = snap_map_cell(ra, dec, size)
    tag = "v7" if epoch == "any" else f"v9|{epoch}"
    digest = hashlib.sha1(
        f"{tag}|{collection}|D{detector}|{size_s:.6f}|{ra_s:.6f}|{dec_s:.6f}".encode()
    ).hexdigest()
    _MAP_TILES.mkdir(parents=True, exist_ok=True)
    path = _MAP_TILES / f"{digest}.png"
    if not (path.exists() and path.stat().st_size > 0):
        _stamp_map_tile(digest, prefetch)
        task = _map_inflight.get(digest)
        if task is None:
            task = asyncio.create_task(
                _build_map_tile(digest, path, ra_s, dec_s, size_s, collection, detector, epoch)
            )
            _map_inflight[digest] = task

            def _done(_t, d=digest):
                _map_inflight.pop(d, None)
                _map_stamp.pop(d, None)

            task.add_done_callback(_done)
        try:
            # Shielded: a client that pans away must not cancel a download others can reuse.
            await asyncio.shield(task)
        except Exception as e:
            raise HTTPException(503, f"IRSA tile failed; retry ({type(e).__name__})") from e
    gap = path.stat().st_size <= len(_BLANK_PNG)
    headers = {"Cache-Control": f"public, max-age={600 if gap else 86400}"}
    dates = path.with_suffix(".dates")
    if dates.exists():
        span, _, mjd = dates.read_text().partition("\n")
        headers["X-Map-Dates"] = span
        if mjd:
            headers["X-Map-Mjd"] = mjd
    return FileResponse(path, media_type="image/png", headers=headers)


_map_inflight: dict[str, asyncio.Task] = {}
_MAP_PREVIEWS = config.CACHE_DIR / "map-previews"


@app.get("/api/map/preview")
async def map_preview(
    ra: float = Query(...),
    dec: float = Query(..., ge=-90, le=90),
    size: float = Query(..., gt=0, le=2),
    detector: int = Query(2, ge=1, le=6),
):
    """Low-resolution stand-in for a sky-map cell from the DR1 all-sky HiPS; ready in about a second."""
    ra_s, dec_s, size_s, _ra_step = snap_map_cell(ra, dec, size)
    digest = hashlib.sha1(f"p1|D{detector}|{size_s:.6f}|{ra_s:.6f}|{dec_s:.6f}".encode()).hexdigest()
    path = _MAP_PREVIEWS / f"{digest}.png"
    if not path.exists():
        try:
            png = await hips_preview.render(ra_s, dec_s, size_s, detector)
        except Exception as e:
            raise HTTPException(503, f"HiPS preview failed; retry ({type(e).__name__})") from e
        _MAP_PREVIEWS.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        tmp.write_bytes(png)
        tmp.replace(path)
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


def _region_mask(region, out_wcs, grid):
    """Tile pixels inside a frame's corner polygon. Great-circle edges are straight on a TAN grid."""
    ras, decs = zip(*region)
    vx, vy = out_wcs.world_to_pixel_values(np.array(ras), np.array(decs))
    ys, xs = grid
    pos = np.ones(ys.shape, dtype=bool)
    neg = np.ones(ys.shape, dtype=bool)
    for i in range(len(vx)):
        x0, y0, x1, y1 = vx[i - 1], vy[i - 1], vx[i], vy[i]
        cross = (x1 - x0) * (ys - y0) - (y1 - y0) * (xs - x0)
        pos &= cross >= 0
        neg &= cross <= 0
    return pos | neg


def _plan_map_frames(frames, covered, out_wcs, shape, limit, rank):
    """Up to `limit` (frame, box) pairs to fetch together, each covering the most still-empty pixels.

    Ties go to the lowest `rank` (url -> position in the block ranking), so the cells of one
    block settle on the same frames and share its rows. `box` is the output-pixel bbox
    (x0, x1, y0, y1) the frame fills. Returns (plan, mask of pixels no planned footprint reaches).
    """
    grid = np.mgrid[0:shape[0], 0:shape[1]]
    masks = [(f, _region_mask(f["region"], out_wcs, grid)) for f in frames if f.get("region")]
    need = ~covered
    chosen = []
    while len(chosen) < limit and need.any():
        best, best_key = None, (0, -math.inf, -math.inf)
        for i, (f, mask) in enumerate(masks):
            key = (np.count_nonzero(mask & need), -rank.get(f["url"], len(rank)), -f["mjd"])
            if key[0] and key > best_key:
                best, best_key = i, key
        if best is None:
            break
        frame, mask = masks.pop(best)
        ys, xs = np.nonzero(mask & need)
        chosen.append((frame, (int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1)))
        need &= ~mask
    return chosen, need


# Frames (with footprints) from recent searches. A cell fully inside a known footprint skips
# the IRSA search.
_MAP_POOL_MAX = 4000
_map_pool: OrderedDict[str, dict] = OrderedDict()
# Frame centre to cell centre: half a frame diagonal (~2.5°) plus half a cell diagonal.
_MAP_POOL_RADIUS = 3.3
# Cells are grouped into sky blocks this wide. One search per block, and a frame ranking
# every cell in the block shares, so a 3.5° frame serves several neighbouring cells.
_MAP_BLOCK_DEG = 3.0
_MAP_BLOCK_GRID_STEP = 12
_MAP_BLOCKS_MAX = 512
_map_blocks: OrderedDict[tuple, asyncio.Task] = OrderedDict()


def _pool_add(frames):
    for f in frames:
        _map_pool[f["url"]] = f
        _map_pool.move_to_end(f["url"])
    while len(_map_pool) > _MAP_POOL_MAX:
        _map_pool.popitem(last=False)


def _pool_add_result(task):
    if not task.cancelled() and task.exception() is None:
        _pool_add(task.result())


def _pool_near(ra, dec, collection, detector):
    near = []
    for f in _map_pool.values():
        if f["collection"] != collection or f["detector"] != detector or f.get("s_ra") is None:
            continue
        d = irsa.sep_deg(ra, dec, f["s_ra"], f["s_dec"])
        if d < _MAP_POOL_RADIUS:
            near.append((d, f))
    return [f for _d, f in sorted(near, key=lambda t: t[0])]


def _rank_block_frames(frames, out_wcs, shape):
    """url -> rank: greedy set cover of the block, then by total coverage, then earliest exposure."""
    grid = np.mgrid[0:shape[0]:_MAP_BLOCK_GRID_STEP, 0:shape[1]:_MAP_BLOCK_GRID_STEP]
    masks = [(f, _region_mask(f["region"], out_wcs, grid)) for f in frames if f.get("region")]
    need = np.ones(grid[0].shape, dtype=bool)
    order = []
    while masks:
        best = max(range(len(masks)), key=lambda i: (
            np.count_nonzero(masks[i][1] & need), np.count_nonzero(masks[i][1]), -masks[i][0]["mjd"]))
        frame, mask = masks.pop(best)
        order.append(frame["url"])
        need &= ~mask
    return {url: i for i, url in enumerate(order)}


async def _block_rank(ra_b, dec_b, collection, detector):
    frames = await irsa.search_frames(ra_b, dec_b, collection, detector)
    _pool_add(frames)
    out_wcs, shape = P.target_wcs(ra_b, dec_b, _MAP_BLOCK_DEG)
    return await asyncio.to_thread(_rank_block_frames, frames, out_wcs, shape)


async def _map_block_rank(ra_s, dec_s, collection, detector):
    """Shared frame ranking for the sky block holding this cell; {} if its search fails."""
    jb = math.floor((dec_s + 90.0) / _MAP_BLOCK_DEG)
    dec_b = min(89.0, max(-89.0, -90.0 + (jb + 0.5) * _MAP_BLOCK_DEG))
    width = _MAP_BLOCK_DEG / max(0.2, math.cos(math.radians(dec_b)))
    kb = math.floor(ra_s / width)
    key = (collection, detector, jb, kb)
    task = _map_blocks.get(key)
    if task is None:
        task = _map_blocks[key] = asyncio.ensure_future(
            _block_rank(((kb + 0.5) * width) % 360.0, dec_b, collection, detector))

        def done(t, key=key):
            if (t.cancelled() or t.exception() is not None) and _map_blocks.get(key) is t:
                del _map_blocks[key]

        task.add_done_callback(done)
        while len(_map_blocks) > _MAP_BLOCKS_MAX:
            _map_blocks.popitem(last=False)
    try:
        return await asyncio.shield(task)
    except Exception as e:
        print(f"map block search failed {key}: {type(e).__name__}: {e}")
        return {}


async def _map_frame_part(frame, ra_s, dec_s, size_s, out_wcs, shape, box, flags=False):
    """One frame reprojected onto the tile grid: (pixels, footprint, artifact-flagged pixels).

    Reads only the rows under `box` from the AWS copy; falls back to IRSA's (much slower)
    cutout service. FLAGS is read only when `flags` is set.
    """
    try:
        hdul = await aws_sections.get_section(frame["url"], out_wcs, shape, box, flags=flags)
    except aws_sections.SectionUnavailable as e:
        print(f"map tile S3 read unavailable ({e}); using IRSA cutout")
        with await irsa.get_cutout(frame["url"], ra_s, dec_s, size_s * _MAP_CUTOUT_PAD) as cutout:
            # Same extensions as the S3 path.
            hdus = [fits.PrimaryHDU(), cutout["IMAGE"].copy()]
            if flags and "FLAGS" in cutout:
                hdus.append(cutout["FLAGS"].copy())
            hdul = fits.HDUList(hdus)
    try:
        return await asyncio.to_thread(P.reproject_frame_footprint, hdul, out_wcs, shape)
    finally:
        hdul.close()


def _epoch_frames(frames, epoch, out_wcs, shape):
    """The frames of the cell's earliest ("first") or latest ("last") survey pass.

    Passes are split per cell (SPHEREx reaches each part of the sky at different dates).
    Passes covering under half the cell are skipped, so a brief edge-on visit does not
    become a mostly empty "first" tile. Near the ecliptic poles coverage never pauses; there
    the first and last _MAP_EPOCH_EDGE_DAYS of the single pass stand in for two passes.
    """
    if epoch == "any" or not frames:
        return frames
    grid = np.mgrid[0:shape[0]:_MAP_BLOCK_GRID_STEP, 0:shape[1]:_MAP_BLOCK_GRID_STEP]
    masks = {f["url"]: _region_mask(f["region"], out_wcs, grid) for f in frames if f.get("region")}
    touching = sorted((f for f in frames if f["url"] in masks and masks[f["url"]].any()),
                      key=lambda f: f["mjd"])
    passes = P.group_epochs(touching)
    if not passes:
        return []

    def coverage(group):
        union = np.zeros(grid[0].shape, dtype=bool)
        for f in group:
            union |= masks[f["url"]]
        return union.mean()

    passes = [g for g in passes if coverage(g) >= 0.5] or passes
    if len(passes) == 1:
        group = passes[0]
        if epoch == "first":
            return [f for f in group if f["mjd"] <= group[0]["mjd"] + _MAP_EPOCH_EDGE_DAYS]
        return [f for f in group if f["mjd"] >= group[-1]["mjd"] - _MAP_EPOCH_EDGE_DAYS]
    return passes[0] if epoch == "first" else passes[-1]


_MAP_EPOCH_EDGE_DAYS = 30


async def _build_map_tile(digest, path, ra_s, dec_s, size_s, collection, detector, epoch="any"):
    """Search + frame reads + PNG for one cell, written to `path`. Raises on IRSA/S3 failure."""
    async with _map_slot(digest):
        if path.exists() and path.stat().st_size > 0:
            return
        out_wcs, shape = P.target_wcs(ra_s, dec_s, size_s)
        arr = np.full(shape, np.nan)
        covered = np.zeros(shape, dtype=bool)

        def near():
            return _epoch_frames(_pool_near(ra_s, dec_s, collection, detector), epoch, out_wcs, shape)

        frames = await asyncio.to_thread(near)
        batch, empty = await asyncio.to_thread(
            _plan_map_frames, frames, covered, out_wcs, shape, _MAP_MAX_FRAMES, {})
        # Unless a known frame already covers the cell, its own search will likely be needed:
        # run it alongside the block search instead of after it. A pass tile always waits for
        # it: frames known from neighbouring searches may miss the cell's earliest or latest pass.
        own = None
        if len(batch) != 1 or empty.any() or epoch != "any":
            own = asyncio.ensure_future(irsa.search_frames(ra_s, dec_s, collection, detector))
            own.add_done_callback(_pool_add_result)
        rank = await _map_block_rank(ra_s, dec_s, collection, detector)
        frames = await asyncio.to_thread(near)
        batch, empty = await asyncio.to_thread(
            _plan_map_frames, frames, covered, out_wcs, shape, _MAP_MAX_FRAMES, rank)
        # The search only returns frames containing one point. The cell's own centre usually
        # finds a frame covering all of it; a cell straddling frame edges can need another
        # search where the known footprints still leave a gap.
        point = (ra_s, dec_s)
        for search in range(_MAP_SEARCHES):
            settled = len(batch) == 1 or search > 0
            if epoch != "any":
                settled = search > 0
            if batch and not empty.any() and settled:
                break
            try:
                if search == 0 and own is not None:
                    found = await own
                else:
                    found = await irsa.search_frames(*point, collection, detector)
            except Exception as e:
                print(f"map tile search failed {point}: {type(e).__name__}: {e}")
                if batch:
                    break
                raise
            if not found and not frames:
                path.write_bytes(_BLANK_PNG)
                return
            _pool_add(found)
            frames = await asyncio.to_thread(near)
            batch, empty = await asyncio.to_thread(
                _plan_map_frames, frames, covered, out_wcs, shape, _MAP_MAX_FRAMES, rank)
            if empty.any():
                ys, xs = np.nonzero(empty)
                gap = out_wcs.pixel_to_world_values(xs.mean(), ys.mean())
                point = (float(gap[0]) % 360.0, float(gap[1]))
        if not batch:
            if not frames:
                path.write_bytes(_BLANK_PNG)
                return
            batch = [(frames[0], None)]

        remaining, budget, last_error = list(frames), _MAP_MAX_FRAMES, None
        # Single-visit tiles leave artifact-flagged pixels uncovered, so the next frame of the
        # same visit fills them. A pixel every frame flags is a real feature (a bright star's
        # core and spill-over): it keeps the first frame's value, kept in `fallback`.
        flags = epoch != "any"
        fallback = np.full(shape, np.nan)
        reached = np.zeros(shape, dtype=bool)
        used = {}
        while batch:
            budget -= len(batch)
            picked = {f["url"] for f, _box in batch}
            remaining = [f for f in remaining if f["url"] not in picked]
            parts = await asyncio.gather(
                *(_map_frame_part(f, ra_s, dec_s, size_s, out_wcs, shape, box, flags)
                  for f, box in batch),
                return_exceptions=True,
            )
            # Batch order is priority order: earlier frames keep the pixels they cover.
            for (frame, _box), part in zip(batch, parts):
                if isinstance(part, BaseException):
                    last_error = part
                    print(f"map tile frame failed ({ra_s}, {dec_s}): {type(part).__name__}: {part}")
                    continue
                data, part_cov, flagged = part
                first_reach = part_cov & ~reached
                fallback[first_reach] = data[first_reach]
                reached |= part_cov
                fresh = part_cov & ~flagged & ~covered
                arr[fresh] = data[fresh]
                covered |= fresh
                if fresh.any():
                    used[frame["mjd"]] = int(fresh.sum())
            # Footprint polygons are approximate; fill any sliver they missed.
            if budget <= 0 or not remaining or covered.mean() >= _MAP_FULL_COVERAGE:
                break
            batch, _empty = await asyncio.to_thread(
                _plan_map_frames, remaining, covered, out_wcs, shape, budget, rank)
        if not covered.any():
            if last_error is not None:
                raise last_error
            path.write_bytes(_BLANK_PNG)
            return
        holes = reached & ~covered
        arr[holes] = fallback[holes]
        covered |= holes

        png = await asyncio.to_thread(P.to_png_alpha, arr, covered)
        # Dates first: the PNG's existence marks the tile as done. The second line is the
        # exposure time of the frame filling most of the tile, for asteroid positions.
        main = max(used, key=used.get)
        path.with_suffix(".dates").write_text(
            f"{P.mjd_to_iso(min(used))}/{P.mjd_to_iso(max(used))}\n{main:.5f}")
        tmp = path.with_suffix(".part")
        tmp.write_bytes(png)
        tmp.replace(path)


# astropy's constellation table keeps the historical misspelling.
_CONSTELLATION_FIXES = {"Ophiucus": "Ophiuchus"}


@app.get("/api/map/point")
async def map_point(
    ra: float = Query(..., ge=0, lt=360),
    dec: float = Query(..., ge=-90, le=90),
    radius_arcmin: float = Query(2.0, gt=0, le=10),
):
    """Sky-map right-click: constellation, the most notable NED object nearby, and its Wikipedia summary.

    `description` is None when Wikipedia has no page; the page writes its own plain sentence then.
    """
    constellation = get_constellation(SkyCoord(ra * u.deg, dec * u.deg, frame="icrs"))
    out = {"ra": ra, "dec": dec, "constellation": _CONSTELLATION_FIXES.get(constellation, constellation)}
    try:
        best = await irsa.nearest_object(ra, dec, radius_arcmin)
    except Exception as e:
        print(f"map point NED failed ({ra}, {dec}): {type(e).__name__}: {e}")
        best = None
        out["error"] = "The object catalog did not answer, so only the constellation is shown."
    out["object"] = irsa.target_public(best, best["ra"], best["dec"]) if best else None
    out["description"] = await irsa.wiki_blurb(best) if best else None
    return out


@app.get("/api/map/visits")
async def map_visits(
    ra: float = Query(..., ge=0, lt=360),
    dec: float = Query(..., ge=-90, le=90),
    collection: str = Query("spherex_dr1"),
):
    """Every SPHEREx frame covering one point, summarized by detector and survey pass."""
    if collection not in config.COLLECTIONS:
        raise HTTPException(400, "Unknown collection")
    try:
        rows = await irsa.search(ra, dec, [collection])
    except irsa.IrsaUnavailable as e:
        raise HTTPException(503, str(e)) from e
    rows.sort(key=lambda r: r["mjd"])
    detectors = []
    for det in sorted({r["detector"] for r in rows}):
        own = [r for r in rows if r["detector"] == det]
        detectors.append({
            "detector": det,
            "n": len(own),
            "lo_um": round(min(r["em_min_um"] for r in own), 3),
            "hi_um": round(max(r["em_max_um"] for r in own), 3),
        })
    passes = [
        {"start": P.mjd_to_iso(g[0]["mjd"]), "end": P.mjd_to_iso(g[-1]["mjd"]), "n": len(g)}
        for g in P.group_epochs(rows)
    ]
    return {
        "collection": collection,
        "total": len(rows),
        "first": P.mjd_to_iso(rows[0]["mjd"]) if rows else None,
        "last": P.mjd_to_iso(rows[-1]["mjd"]) if rows else None,
        "detectors": detectors,
        "passes": passes,
    }


@app.get("/api/map/known")
async def map_known(
    ra: float = Query(...),
    dec: float = Query(..., ge=-90, le=90),
    size: float = Query(..., gt=0, le=2),
    mjd: str = Query("", pattern=r"^[0-9.,]*$", description="Up to two exposure times (MJD)"),
):
    """Known movers around one sky-map cell, to tell a discovery from a catalogued object.

    `stars`: Gaia DR3 stars faster than 100 mas/yr, at epoch 2016.0 with their proper motion.
    `bodies`: asteroids and comets at each requested exposure time (the X-Map-Mjd of the cell's
    first- and last-visit tiles), as {"mjd", "items", "complete"}.
    """
    ra_s, dec_s, size_s, _ra_step = snap_map_cell(ra, dec, size)
    # Reaches the corners of the cell (half its diagonal is 0.71 cell).
    radius = size_s * 0.75
    times = sorted({round(float(m), 5) for m in mjd.split(",") if m.strip(".")})[:2]
    if any(not 50000 < m < 80000 for m in times):
        raise HTTPException(400, "mjd out of range")
    results = await asyncio.gather(
        known_objects.gaia_movers(ra_s, dec_s, radius),
        *(known_objects.solar_system(ra_s, dec_s, radius, m) for m in times),
        return_exceptions=True,
    )
    errors = []

    def value(result, what):
        if isinstance(result, BaseException):
            print(f"map known {what} failed ({ra_s}, {dec_s}): {type(result).__name__}: {result}")
            errors.append(f"The {what} list did not answer.")
            return None
        return result

    stars = value(results[0], "Gaia star")
    bodies = [{"mjd": m, **found}
              for m, r in zip(times, results[1:])
              if (found := value(r, "asteroid")) is not None]
    if any(not b["complete"] for b in bodies):
        errors.append("Asteroid positions are missing for a small part of this patch.")
    headers = {"Cache-Control": f"public, max-age={60 if errors else 86400}"}
    payload = {"ra": ra_s, "dec": dec_s, "stars": stars or [], "bodies": bodies, "errors": errors}
    return JSONResponse(payload, headers=headers)


@app.get("/api/context/catalogs")
def context_catalogs(
    ra: float = Query(...),
    dec: float = Query(...),
    radius_deg: float = Query(0.15, ge=0.01, le=1.0),
    gaia: bool = True,
    wise: bool = True,
):
    """Gaia DR3 + AllWISE markers via IRSA SCS (avoids CDS VizieR, which is often blocked)."""
    return context_sky.sky_catalogs(ra, dec, radius_deg, gaia=gaia, wise=wise)


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
