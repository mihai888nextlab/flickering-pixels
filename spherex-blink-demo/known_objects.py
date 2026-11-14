"""Known moving objects around a sky-map cell: fast Gaia stars and Solar System bodies.

A red/cyan pair on the map is only a discovery if neither list explains it. Answers are
cached on disk: Gaia positions never change, and a body's position at one exposure time
never changes either.
"""
import asyncio
import csv
import hashlib
import io
import json
import math

import astropy.units as u
import httpx
from astropy.coordinates import Angle

import config

IRSA_TAP = "https://irsa.ipac.caltech.edu/TAP/sync"
SKYBOT = "https://ssp.imcce.fr/webservices/skybot/api/conesearch.php"
# 100 mas/yr is the usual "high proper motion" cut; slower stars shift well under a pixel.
MIN_PM_MAS_YR = 100
# Fainter than this, SPHEREx single frames show nothing.
MAX_G_MAG = 20
MAX_V_MAG = 20

_CACHE = config.CACHE_DIR / "known-objects"
_client = httpx.AsyncClient(
    timeout=httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=30.0),
    headers={"User-Agent": "FlickeringPixels/1.0 (NASA Space Apps)"},
    follow_redirects=True,
)
_inflight: dict[str, asyncio.Task] = {}


async def _cached(name, fetch):
    """`await fetch()` once per `name`, then from disk; concurrent callers share one request."""
    path = _CACHE / f"{hashlib.sha1(name.encode()).hexdigest()}.json"
    if path.exists():
        return json.loads(path.read_text())

    async def run():
        data = await fetch()
        _CACHE.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        tmp.write_text(json.dumps(data))
        tmp.replace(path)
        return data

    task = _inflight.get(name)
    if task is None:
        task = _inflight[name] = asyncio.ensure_future(run())
        task.add_done_callback(lambda _t: _inflight.pop(name, None))
    return await asyncio.shield(task)


async def gaia_movers(ra, dec, radius):
    """Gaia DR3 stars moving at least MIN_PM_MAS_YR. Positions are at epoch 2016.0."""
    query = (
        "SELECT source_id, ra, dec, pmra, pmdec, phot_g_mean_mag FROM gaia_dr3_source "
        f"WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra:.6f}, {dec:.6f}, {radius:.4f})) = 1 "
        f"AND pmra * pmra + pmdec * pmdec > {MIN_PM_MAS_YR ** 2} AND phot_g_mean_mag < {MAX_G_MAG}"
    )

    async def fetch():
        r = await _client.post(IRSA_TAP, data={"QUERY": query, "FORMAT": "csv"})
        r.raise_for_status()
        out = []
        for row in csv.DictReader(io.StringIO(r.text)):
            try:
                out.append({
                    "name": f"Gaia DR3 {row['source_id']}",
                    "ra": float(row["ra"]),
                    "dec": float(row["dec"]),
                    "pmra": float(row["pmra"]),
                    "pmdec": float(row["pmdec"]),
                    "g": round(float(row["phot_g_mean_mag"]), 2),
                })
            except (KeyError, ValueError):
                continue
        return out

    return await _cached(f"gaia|{MIN_PM_MAS_YR}|{MAX_G_MAG}|{ra:.6f}|{dec:.6f}|{radius:.4f}", fetch)


async def _skybot(ra, dec, radius, mjd):
    params = {
        "-ep": f"{mjd + 2400000.5:.5f}",
        "-ra": f"{ra % 360.0:.6f}",
        "-dec": f"{dec:.6f}",
        "-rd": f"{radius:.4f}",
        "-mime": "json",
        "-output": "object",
        "-loc": "500",
        "-filter": "0",
        # Asteroids and comets; planets are bright enough to need no flag.
        "-objFilter": "110",
        "-refsys": "EQJ2000",
        "-from": "FlickeringPixels",
    }
    r = await _client.get(SKYBOT, params=params)
    text = r.text.strip()
    if not text.startswith("["):
        # An empty field comes back as a plain-text message, not an empty list.
        if r.status_code < 500 and "no solar system object" in text.lower():
            return []
        r.raise_for_status()
        raise RuntimeError(f"SkyBoT: {text[:160]}")
    out = []
    for row in json.loads(text):
        vmag = row.get("VMag (mag)")
        if vmag is not None and vmag > MAX_V_MAG:
            continue
        try:
            out.append({
                "name": row["Name"],
                "kind": row.get("Class", ""),
                "ra": float(Angle(row["RA (hms)"], unit=u.hourangle).deg),
                "dec": float(Angle(row["DEC (dms)"], unit=u.deg).deg),
                "v": vmag,
            })
        except (KeyError, ValueError):
            continue
    return out


async def _skybot_cover(ra, dec, radius, mjd, depth=0):
    """(items, complete) for the cone. SkyBoT fails a whole cone on one bad ephemeris
    ("planetary_ephem: satellite: calceph_compute_unit error"); smaller cones around it still
    answer, so a failing cone is split into four (radius 0.6, together covering it)."""
    try:
        return await _skybot(ra, dec, radius, mjd), True
    except RuntimeError:
        if depth >= 2:
            return [], False
    cos = max(0.2, math.cos(math.radians(dec)))
    step = radius / 2
    parts = await asyncio.gather(*(
        _skybot_cover(ra + sx * step / cos, dec + sy * step, radius * 0.6, mjd, depth + 1)
        for sx in (-1, 1) for sy in (-1, 1)
    ))
    seen = {}
    for items, _complete in parts:
        for item in items:
            seen.setdefault(item["name"], item)
    return list(seen.values()), all(complete for _items, complete in parts)


async def solar_system(ra, dec, radius, mjd):
    """Asteroids and comets inside the cone at `mjd` (geocentric; SPHEREx's low orbit
    shifts them by under an arcsecond), from IMCCE's SkyBoT.

    {"items": [...], "complete": False if a small patch of the cone could not be computed}.
    """

    async def fetch():
        items, complete = await _skybot_cover(ra, dec, radius, mjd)
        return {"items": items, "complete": complete}

    return await _cached(f"skybot2|{MAX_V_MAG}|{ra:.6f}|{dec:.6f}|{radius:.4f}|{mjd:.5f}", fetch)
