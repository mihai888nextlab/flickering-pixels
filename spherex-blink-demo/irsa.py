"""Talks to the official NASA/IPAC IRSA services: SIA image search + cutouts."""
import asyncio
import csv
import hashlib
import io
import math
import re
import time
import warnings
from xml.etree import ElementTree as ET

import httpx
from astropy.io import fits

import config

# NED Preferred.ObjType / Phys Type → human Kind label for the tool UI.
NED_TYPE_LABELS = {
    "G": "Galaxy",
    "GiP": "Galaxy",
    "GiC": "Galaxy",
    "QSO": "Quasar",
    "GPair": "Galaxy pair",
    "GGroup": "Galaxy group",
    "GClstr": "Galaxy cluster",
    "AbLS": "Abell cluster",
    "PofG": "Part of galaxy",
    "*": "Star",
    "**": "Double star",
    "*Ass": "Stellar association",
    "*Cl": "Star cluster",
    "V*": "Variable star",
    "PN": "Planetary nebula",
    "HII": "H II region",
    "SNR": "Supernova remnant",
    "SN": "Supernova",
    "Neb": "Nebula",
    "IrS": "IR source",
    "RadioS": "Radio source",
    "VisS": "Visual source",
    "UvS": "UV source",
    "XrayS": "X-ray source",
    "GammaS": "Gamma-ray source",
    "Other": "Other",
    "Unknwn": "Unknown",
}

warnings.simplefilter("ignore")

_sem = asyncio.Semaphore(config.MAX_CONCURRENT_DOWNLOADS)
# Cutouts can be large; SIA search is patient — IRSA often needs many retries.
# Keep cutout reads short so one hung frame cannot stall an entire job at 23/24.
_timeout = httpx.Timeout(connect=12.0, read=40.0, write=12.0, pool=12.0)
_cutout_timeout = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)
# Keep SIA searches snappy: IRSA often stalls; fail fast and retry instead of sitting on attempt 1.
_search_timeout = httpx.Timeout(connect=8.0, read=22.0, write=8.0, pool=8.0)
_SEARCH_DEADLINE_S = 90.0
_SEARCH_TRIES = 2
# After the first release answers, how long to keep waiting for the others.
_PARTIAL_GRACE_S = 30.0
_client = httpx.AsyncClient(
    timeout=_timeout,
    follow_redirects=True,
    limits=httpx.Limits(
        max_connections=max(32, config.MAX_CONCURRENT_DOWNLOADS * 2),
        max_keepalive_connections=config.MAX_CONCURRENT_DOWNLOADS,
    ),
)

# Extensions we keep; PSF is ~5 MB per cutout and unused here, so it is dropped before caching.
KEEP_EXT = ("IMAGE", "FLAGS", "VARIANCE", "ZODI", "WCS-WAVE")
_RETRY_STATUSES = {408, 425, 429, 500, 502, 503, 504}


class IrsaUnavailable(RuntimeError):
    """IRSA search/cutout failed after retries."""


async def _get(url, params=None, tries=8, timeout=None, backoff=2.0, on_retry=None, **kw):
    """GET with retries: IRSA often returns 504 / drops connections under load."""
    last: Exception | None = None
    for i in range(tries):
        try:
            r = await _client.get(url, params=params, timeout=timeout, **kw)
            if r.status_code in _RETRY_STATUSES:
                raise httpx.HTTPStatusError(
                    f"IRSA {r.status_code}",
                    request=r.request,
                    response=r,
                )
            r.raise_for_status()
            return r
        except (httpx.TransportError, httpx.TimeoutException, httpx.HTTPStatusError) as e:
            last = e
            # Do not retry clear client errors (except the statuses above).
            if isinstance(e, httpx.HTTPStatusError) and e.response is not None:
                if e.response.status_code not in _RETRY_STATUSES and e.response.status_code < 500:
                    raise
            if i == tries - 1:
                break
            if on_retry:
                try:
                    on_retry(i + 2, e)
                except Exception:
                    pass
            await asyncio.sleep(min(6, backoff * (i + 1)))
    assert last is not None
    raise IrsaUnavailable(
        "NASA/IPAC IRSA timed out or is overloaded (often a 504 Gateway Timeout). "
        "Keep the page open and click Load again to continue waiting."
    ) from last


_SIA_COLUMNS = {"obs_id", "access_url", "energy_bandpassname", "t_min", "em_min", "em_max"}


def _parse_polygon(s_region: str):
    """[(ra, dec), ...] corners from an ObsCore 'POLYGON ICRS ...' footprint, or None."""
    parts = s_region.split()
    if len(parts) < 8 or parts[0].upper() != "POLYGON":
        return None
    try:
        float(parts[1])
        coords = parts[1:]
    except ValueError:
        coords = parts[2:]  # frame name, e.g. ICRS
    try:
        nums = [float(p) for p in coords]
    except ValueError:
        return None
    pts = list(zip(nums[0::2], nums[1::2]))
    if len(pts) > 3 and pts[0] == pts[-1]:
        pts.pop()
    return pts if len(pts) >= 3 else None


def _parse_sia_csv(text: str, collection: str):
    """Science rows from one SIA CSV.

    Returns (rows, None) for a real table, including zero images.
    Returns ([], reason) when the body is not a usable catalog reply.
    """
    sample = (text or "").lstrip()
    if not sample:
        return [], "empty body"
    if sample[0] in "<{":
        return [], "non-CSV response"
    reader = csv.DictReader(io.StringIO(text))
    fields = set(reader.fieldnames or [])
    if not _SIA_COLUMNS <= fields:
        return [], "unexpected CSV columns"
    rows = []
    for row in reader:
        if row.get("dataproduct_subtype", "science") != "science":
            continue
        try:
            band = row.get("energy_bandpassname") or ""
            m = re.search(r"D(\d)", band)
            s_ra = row.get("s_ra") or ""
            s_dec = row.get("s_dec") or ""
            rows.append({
                "collection": collection,
                "obs_id": row["obs_id"],
                "detector": int(m.group(1)) if m else 0,
                "mjd": float(row["t_min"]),
                "em_min_um": float(row["em_min"]) * 1e6,
                "em_max_um": float(row["em_max"]) * 1e6,
                "url": row["access_url"],
                "s_ra": float(s_ra) if s_ra else None,
                "s_dec": float(s_dec) if s_dec else None,
                "region": _parse_polygon(row.get("s_region") or ""),
            })
        except (KeyError, TypeError, ValueError) as e:
            return [], f"bad row ({e})"
    return rows, None


def sep_deg(ra1, dec1, ra2, dec2):
    """Small-angle sky separation in degrees."""
    dra = (ra2 - ra1 + 180.0) % 360.0 - 180.0
    return math.hypot(dra * math.cos(math.radians((dec1 + dec2) / 2)), dec2 - dec1)


async def search_frames(ra, dec, collection, detector):
    """Science frames for one detector covering (ra, dec), most central first.

    BAND keeps IRSA to one detector's rows instead of every visit in every band.
    Returns [] when nothing covers the point.
    """
    band = config.DETECTOR_BANDS[detector]
    mid = (band["lo"] + band["hi"]) / 2
    half = (band["hi"] - band["lo"]) / 4
    params = {
        "COLLECTION": collection,
        "POS": f"CIRCLE {ra} {dec} 0.001",
        "BAND": f"{(mid - half) * 1e-6:.4e} {(mid + half) * 1e-6:.4e}",
        "MAXREC": "60",
        "RESPONSEFORMAT": "CSV",
    }
    r = await _get(config.SIA_URL, params=params, tries=2, timeout=_search_timeout, backoff=1.0)
    rows, parse_err = _parse_sia_csv(r.text, collection)
    if parse_err:
        raise IrsaUnavailable(f"IRSA search: {parse_err}")
    rows = [row for row in rows if row["detector"] == detector]

    def offset(row):
        if row.get("s_ra") is None or row.get("s_dec") is None:
            return math.inf
        return sep_deg(ra, dec, row["s_ra"], row["s_dec"])

    return sorted(rows, key=offset)


async def search(ra, dec, collections, radius=0.001, on_attempt=None, report=None):
    """Every SPHEREx image covering (ra, dec), across the requested releases.

    Each release's answer is kept as it arrives; only releases that failed are asked again.
    Once some releases have answered, the rest get up to _PARTIAL_GRACE_S more before the
    search returns what it has, listing the missing releases in ``report["missing"]``
    (older releases hold the older survey passes, which motion and blinking need).
    Transport failures retry until the deadline. A real empty catalog returns
    immediately so "no coverage" is not reported as an archive timeout.
    """
    t0 = time.monotonic()
    colls = list(collections) or list(config.DEFAULT_COLLECTIONS)
    got: dict[str, list] = {}  # release -> rows from a valid answer (possibly empty)
    errors: dict[str, str] = {}
    first_rows_at = None
    empty_passes = 0

    def collected():
        return [r for c in colls for r in got.get(c, [])]

    for attempt in range(1, 13):
        now = time.monotonic()
        if now - t0 > _SEARCH_DEADLINE_S:
            break
        if first_rows_at is not None and now - first_rows_at > _PARTIAL_GRACE_S:
            break
        todo = [c for c in colls if c not in got]
        if on_attempt:
            if got:
                on_attempt(attempt, f"Got {len(got)}/{len(colls)} releases; waiting on "
                                    f"{', '.join(todo)}… attempt {attempt}")
            else:
                on_attempt(attempt, f"Querying IRSA SIA… attempt {attempt}")

        # Sequential collections — parallel POS queries often stall IRSA under load.
        for coll in todo:
            if time.monotonic() - t0 > _SEARCH_DEADLINE_S:
                break

            def _retry_note(retry_n, err, _coll=coll, _attempt=attempt):
                if on_attempt:
                    kind = type(err).__name__.replace("Exception", "")
                    on_attempt(
                        _attempt,
                        f"IRSA slow ({_coll}) — retry {retry_n}/{_SEARCH_TRIES} · {kind}",
                    )

            params = {
                "COLLECTION": coll,
                "POS": f"CIRCLE {ra} {dec} {radius}",
                "RESPONSEFORMAT": "CSV",
            }
            try:
                r = await _get(
                    config.SIA_URL,
                    params=params,
                    tries=_SEARCH_TRIES,
                    timeout=_search_timeout,
                    backoff=1.5,
                    on_retry=_retry_note,
                )
            except Exception as e:
                errors[coll] = f"{coll}: {e}"
                continue
            parsed, parse_err = _parse_sia_csv(r.text, coll)
            if parse_err:
                errors[coll] = f"{coll}: {parse_err}"
                continue
            got[coll] = parsed
            errors.pop(coll, None)

        rows = collected()
        if rows and first_rows_at is None:
            first_rows_at = time.monotonic()
        if len(got) == len(colls):
            if rows:
                break
            # Every release answered with an empty table. Ask once more: IRSA occasionally
            # answers 200 with an empty table under load.
            empty_passes += 1
            if empty_passes >= 2:
                return []
            got.clear()
        await asyncio.sleep(min(8, 1.5 + attempt * 0.5))

    rows = collected()
    if rows:
        if report is not None:
            report["missing"] = [c for c in colls if c not in got]
        rows.sort(key=lambda r: r["mjd"])
        return rows
    if not errors:
        return []
    detail = " · ".join(errors.values())
    raise IrsaUnavailable(
        "Could not reach the IRSA image archive in time. "
        "The service is often slow — lock again in a moment. "
        + detail
    )


def filter_detectors(rows, detectors):
    """Keep only selected SPHEREx detectors (1–6). Empty/None → all."""
    if not detectors:
        return rows
    wanted = {int(d) for d in detectors if 1 <= int(d) <= 6}
    if not wanted:
        return rows
    return [r for r in rows if r["detector"] in wanted]


def sample_frames(rows, max_frames):
    """Evenly thin the list per detector so a demo request stays fast."""
    if len(rows) <= max_frames:
        return rows
    by_det = {}
    for r in rows:
        by_det.setdefault(r["detector"], []).append(r)
    per_det = max(1, max_frames // max(1, len(by_det)))
    out = []
    for lst in by_det.values():
        n = min(per_det, len(lst))
        step = len(lst) / n
        out += [lst[int(i * step)] for i in range(n)]
    return sorted(out, key=lambda r: r["mjd"])


async def get_cutout(url, ra, dec, size):
    """Cutout as an HDUList (cached on disk, PSF stripped)."""
    key = hashlib.sha1(f"{url}|{ra:.5f}|{dec:.5f}|{size:.4f}".encode()).hexdigest()
    path = config.CACHE_DIR / f"{key}.fits"
    if not path.exists():
        async with _sem:
            # Hard ceiling so a single IRSA stall cannot freeze the job near 100%.
            r = await asyncio.wait_for(
                _get(
                    url,
                    params={"center": f"{ra},{dec}", "size": f"{size}"},
                    tries=2,
                    backoff=0.8,
                    timeout=_cutout_timeout,
                ),
                timeout=45.0,
            )
        with fits.open(io.BytesIO(r.content)) as h:
            keep = fits.HDUList([fits.PrimaryHDU(header=h[0].header)] +
                                [h[e].copy() for e in KEEP_EXT if e in h])
            tmp = path.with_suffix(".part")
            keep.writeto(tmp, overwrite=True)
            tmp.rename(path)
    # Read the whole file into memory: astropy opens FITS lazily, and an HDUList returned
    # straight from fits.open(path) keeps its file descriptor open for as long as it lives
    # (jobs keep their cutouts) — that leaked descriptors until "Too many open files".
    return fits.open(io.BytesIO(path.read_bytes()))


class NameResolveUnavailable(RuntimeError):
    """Remote name resolver timed out / could not be reached."""


# Backward-compatible alias for older imports.
SesameUnavailable = NameResolveUnavailable


def _norm_name(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip().lower().replace("_", " "))


def _local_name_hit(query: str):
    """Fallback for nearby stars / challenge objects that NED (extragalactic) may miss."""
    key = _norm_name(query)
    aliases = {
        "m31": "andromeda",
        "ngc 224": "andromeda",
        "andromeda": dict(name="Andromeda Galaxy (M31)", ra=10.68479292, dec=41.269065,
                          pm_ra=0.0, pm_dec=0.0, ref_epoch=2000.0),
        "andromeda galaxy": "andromeda",
        "messier 31": "andromeda",
        "messier 031": "andromeda",
    }
    for preset in config.PRESETS.values():
        aliases[_norm_name(preset["name"])] = preset
        # short tokens: "barnard", "barnard's star"
        first = _norm_name(preset["name"].split()[0].rstrip("'s"))
        aliases.setdefault(first, preset)
        aliases.setdefault(first + "s star", preset)
        aliases.setdefault(first + "'s star", preset)

    # Extra common star / BD aliases used in demos.
    aliases.update({
        "gj 699": config.PRESETS["barnard"],
        "hip 87937": config.PRESETS["barnard"],
        "v2500 oph": config.PRESETS["barnard"],
        "wise 0855": config.PRESETS["wise0855"],
        "wise0855": config.PRESETS["wise0855"],
        "wise j0855-0714": config.PRESETS["wise0855"],
        "epsilon indi": config.PRESETS["eps_indi_b"],
        "eps indi b": config.PRESETS["eps_indi_b"],
        "eps indi": config.PRESETS["eps_indi_b"],
    })

    hit = aliases.get(key)
    while isinstance(hit, str):
        hit = aliases.get(hit)
    if not hit:
        return None
    kind = hit.get("kind")
    if not kind and "Andromeda" in hit["name"]:
        kind = "Galaxy"
    return dict(
        name=hit["name"],
        ra=hit["ra"],
        dec=hit["dec"],
        pm_ra=hit.get("pm_ra", 0.0),
        pm_dec=hit.get("pm_dec", 0.0),
        ref_epoch=hit.get("ref_epoch", 2000.0),
        kind=kind,
        resolver="local",
    )


def kind_from_ned_type(code: str | None) -> str | None:
    if not code:
        return None
    code = str(code).strip()
    return NED_TYPE_LABELS.get(code, code)


def _ned_redshift(preferred: dict):
    z = (preferred.get("Redshift") or {}).get("Value")
    try:
        return float(z) if z is not None else None
    except (TypeError, ValueError):
        return None


async def _ned_lookup(query: str):
    """NASA/IPAC NED name resolver (JSON). Returns dict or None if unknown."""
    timeout = httpx.Timeout(connect=15.0, read=30.0, write=15.0, pool=15.0)
    r = await _client.post(
        config.NED_LOOKUP_URL,
        json={"name": {"v": query}},
        timeout=timeout,
    )
    r.raise_for_status()
    data = r.json()
    preferred = data.get("Preferred") or {}
    pos = preferred.get("Position") or {}
    ra, dec = pos.get("RA"), pos.get("Dec")
    if ra is None or dec is None:
        return None
    obj_type = (preferred.get("ObjType") or {}).get("Value")
    return dict(
        name=preferred.get("Name") or query,
        ra=float(ra),
        dec=float(dec),
        pm_ra=0.0,
        pm_dec=0.0,
        ref_epoch=2000.0,
        kind=kind_from_ned_type(obj_type),
        obj_type=obj_type,
        redshift=_ned_redshift(preferred),
        resolver="ned",
    )


def _hms_to_deg(h: float, m: float, s: float) -> float:
    return (h + m / 60.0 + s / 3600.0) * 15.0


def _dms_to_deg(sign: float, d: float, m: float, s: float) -> float:
    return sign * (abs(d) + m / 60.0 + s / 3600.0)


def _parse_simbad_ascii(text: str, query: str):
    """Parse Harvard/CDS SIMBAD ASCII identity page → target dict or None."""
    if not text or "No astronomical object found" in text or "Identifier not found" in text:
        return None
    # Title line is usually the queried name, repeated after the banner.
    name = query
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("C.D.S") or set(s) <= {"-"}:
            continue
        if s.startswith("Object ") or s.startswith("Coordinates") or s.startswith("Proper"):
            break
        name = s
        break

    coo = re.search(
        r"Coordinates\(ICRS,[^)]+\):\s*"
        r"(\d+)[^\d]+(\d+)[^\d]+(\d+(?:\.\d+)?)\s+"
        r"([+-])\s*(\d+)[^\d]+(\d+)[^\d]+(\d+(?:\.\d+)?)",
        text,
    )
    if not coo:
        # Decimal fallback if SIMBAD ever returns degrees.
        dec_coo = re.search(
            r"Coordinates\(ICRS,[^)]+\):\s*([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)",
            text,
        )
        if not dec_coo:
            return None
        ra, dec = float(dec_coo.group(1)), float(dec_coo.group(2))
    else:
        sign = -1.0 if coo.group(4) == "-" else 1.0
        ra = _hms_to_deg(float(coo.group(1)), float(coo.group(2)), float(coo.group(3)))
        dec = _dms_to_deg(
            sign, float(coo.group(5)), float(coo.group(6)), float(coo.group(7))
        )

    pm_ra = pm_dec = 0.0
    pm = re.search(
        r"Proper motions:\s*([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)",
        text,
    )
    if pm:
        pm_ra, pm_dec = float(pm.group(1)), float(pm.group(2))

    otype = None
    obj = re.search(r"^Object\s+(.+)$", text, re.M)
    if obj:
        # e.g. "* alf Cyg  ---  sg*  ---  OID=..."
        parts = [p.strip() for p in obj.group(1).split("---")]
        if parts:
            # Prefer a human identifier from the object line when nicer than the query.
            head = parts[0]
            if head.startswith("*"):
                head = head.lstrip("*").strip()
            if head:
                name = head
        if len(parts) > 1 and parts[1]:
            otype = parts[1]

    kind = "Star"
    if otype:
        low = otype.lower()
        if (
            "galaxy" in low
            or otype in {"G", "GiC", "GiP", "BiC", "AGN", "Sy1", "Sy2", "LSB", "SBG"}
            or low.startswith("gi")
        ):
            kind = "Galaxy"
        elif "qso" in low or "blazar" in low or otype in {"QSO", "Blazar"}:
            kind = "Quasar"
        elif "neb" in low or otype in {"PN", "HII", "SNR", "ISM"}:
            kind = "Nebula"
        elif "*" in otype or "star" in low or otype.startswith(("V", "sg", "supergiant", "Em")):
            kind = "Star"
        else:
            kind = otype

    # Keep the user's common name when they typed one (e.g. "Deneb" over "alf Cyg").
    display = query.strip()
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9' \-]{0,40}", display) and not re.match(
        r"(?i)(ngc|ic|hd|hip|hr|tyc|2mass|wise|gaia)\b", display
    ):
        name = display

    out = dict(
        name=name,
        ra=ra,
        dec=dec,
        pm_ra=pm_ra,
        pm_dec=pm_dec,
        ref_epoch=2000.0,
        kind=kind,
        obj_type=otype,
        resolver="simbad",
    )
    gaia = re.search(r"Gaia\s*DR3\s+(\d+)", text, re.I)
    if gaia:
        out["gaia_source_id"] = gaia.group(1)
        out["resolver"] = "gaia"
    return out


async def _simbad_lookup(query: str):
    """SIMBAD identity lookup (Harvard mirror) for stellar / common names."""
    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    r = await _client.get(
        config.SIMBAD_ID_URL,
        params={
            "Ident": query,
            "NbIdent": "1",
            "output.format": "ASCII",
            "obj.cooN": "on",
            "obj.pmsel": "on",
        },
        timeout=timeout,
    )
    r.raise_for_status()
    return _parse_simbad_ascii(r.text, query)


async def _gaia_tap_by_id(query: str):
    """ESA Gaia TAP lookup when the query is a Gaia DR3 source id."""
    m = re.fullmatch(r"(?:Gaia\s*)?(?:DR3\s*)?(\d{5,})", query.strip(), flags=re.I)
    if not m:
        return None
    source_id = m.group(1)
    timeout = httpx.Timeout(connect=8.0, read=18.0, write=8.0, pool=8.0)
    adql = (
        "SELECT TOP 1 source_id, ra, dec, pmra, pmdec "
        "FROM gaiadr3.gaia_source "
        f"WHERE source_id = {source_id}"
    )
    r = await _client.post(
        config.GAIA_TAP_URL,
        data={
            "REQUEST": "doQuery",
            "LANG": "ADQL",
            "FORMAT": "csv",
            "QUERY": adql,
        },
        timeout=timeout,
    )
    r.raise_for_status()
    rows = list(csv.DictReader(io.StringIO(r.text)))
    if not rows:
        return None
    row = rows[0]
    try:
        ra, dec = float(row["ra"]), float(row["dec"])
    except (KeyError, TypeError, ValueError):
        return None

    def _f(key: str) -> float:
        try:
            return float(row.get(key) or 0.0)
        except ValueError:
            return 0.0

    return dict(
        name=f"Gaia DR3 {source_id}",
        ra=ra,
        dec=dec,
        pm_ra=_f("pmra"),
        pm_dec=_f("pmdec"),
        ref_epoch=2016.0,
        kind="Star",
        gaia_source_id=source_id,
        resolver="gaia",
    )


async def _safe_resolve(coro):
    """Run a resolver; return (hit|None, error|None)."""
    try:
        return await coro, None
    except (httpx.TransportError, httpx.TimeoutException, httpx.HTTPStatusError) as e:
        return None, e
    except Exception as e:
        return None, e


def _ned_cone_rank(row: dict) -> tuple:
    """Prefer famous / extended objects over anonymous IR/X-ray detections.

    NED cone often returns a WISEA source a fraction of an arcsec closer than
    Messier 101 itself — rank by type + name quality, then separation.
    """
    phys = (row.get("Phys Type") or "").strip()
    name = (row.get("Object Name") or "").strip()
    try:
        sep = float(row.get("Separation") or "nan")
    except ValueError:
        sep = 999.0

    type_rank = {
        "G": 0,
        "GPair": 1,
        "GGroup": 2,
        "GClstr": 2,
        "QSO": 3,
        "*": 6,
        "**": 6,
        "V*": 6,
        "*Ass": 7,
        "*Cl": 8,
        "PN": 9,
        "HII": 10,
        "SNR": 10,
        "Neb": 10,
        "IrS": 18,
        "RadioS": 18,
        "UvS": 18,
        "XrayS": 18,
        "GammaS": 18,
        "VisS": 16,
        "Other": 15,
        "Unknwn": 15,
    }.get(phys, 14 if phys else 17)

    name_rank = 5
    if re.match(r"(?i)^(messier|m)\s*\d+", name):
        name_rank = 0
    elif re.match(r"(?i)^(ngc|ic)\s*\d+", name):
        name_rank = 1
    elif re.match(r"(?i)^(wisea|wise |2mass|2cxo|cxo |rx |ztf|gaia)", name):
        name_rank = 9
    elif re.search(r"\[", name):
        name_rank = 8  # catalog component labels inside a host

    return (type_rank, name_rank, sep)


def _parse_ned_cone_votable(text: str):
    """Return best NED cone row (typed host preferred over nearest IR hit)."""
    rows = _ned_cone_rows(text)
    if not rows:
        return None
    rows.sort(key=_ned_cone_rank)
    return rows[0]


def _ned_cone_rows(text: str) -> list[dict]:
    """Every object row in a NED cone VOTable, as {column name: text}."""
    root = ET.fromstring(text)
    fields = root.findall(".//{http://www.ivoa.net/xml/VOTable/v1.3}FIELD") or root.findall(".//FIELD")
    names = [f.attrib.get("name") for f in fields]
    table = root.find(".//{http://www.ivoa.net/xml/VOTable/v1.3}TABLEDATA") or root.find(".//TABLEDATA")
    if table is None or not names:
        return []
    rows = []
    for tr in list(table):
        vals = [c.text if c.text is not None else "" for c in list(tr)]
        row = dict(zip(names, vals))
        if row.get("Object Name"):
            rows.append(row)
    return rows


async def _ned_cone_fetch(ra: float, dec: float, radius_arcmin: float, maxrec: int = 25) -> str:
    timeout = httpx.Timeout(connect=15.0, read=45.0, write=15.0, pool=15.0)
    r = await _client.get(
        config.NED_CONE_URL,
        params={
            "LON": f"{ra}d",
            "LAT": str(dec),
            "CSYS": "Equatorial",
            "EQUINOX": "J2000.0",
            "RADIUS": str(radius_arcmin),
            "MAXREC": str(maxrec),
        },
        timeout=timeout,
    )
    r.raise_for_status()
    return r.text


async def _ned_cone(ra: float, dec: float, radius_arcmin: float | None = None):
    """Best NED object near (ra, dec). Separation is arcminutes in the VOTable."""
    radius = radius_arcmin if radius_arcmin is not None else max(config.NED_CONE_RADIUS_ARCMIN, 2.0)
    row = _parse_ned_cone_votable(await _ned_cone_fetch(ra, dec, radius))
    if not row:
        return None
    return _ned_cone_target(row, ra, dec)


async def nearest_object(ra: float, dec: float, radius_arcmin: float):
    """Most notable NED object within `radius_arcmin` of (ra, dec), or None."""
    return await _ned_cone(ra, dec, radius_arcmin)


def _ned_cone_target(row: dict, ra: float, dec: float):
    """One NED cone row → target dict, or None when it has no usable position."""
    try:
        obj_ra, obj_dec = float(row["RA"]), float(row["Dec"])
        sep_arcmin = float(row.get("Separation") or 0.0)
    except (KeyError, ValueError, TypeError):
        return None
    z_raw = (row.get("Redshift (z)") or "").strip()
    try:
        redshift = float(z_raw) if z_raw else None
    except ValueError:
        redshift = None
    phys = (row.get("Phys Type") or "").strip() or None
    return dict(
        name=row.get("Object Name") or f"{ra:.5f}, {dec:+.5f}",
        ra=obj_ra,
        dec=obj_dec,
        pm_ra=0.0,
        pm_dec=0.0,
        ref_epoch=2000.0,
        kind=kind_from_ned_type(phys),
        obj_type=phys,
        redshift=redshift,
        separation_arcsec=round(sep_arcmin * 60.0, 2),
        resolver="ned-cone",
        query_ra=ra,
        query_dec=dec,
    )


async def resolve_name(name):
    """Name → (ra, dec, pm_ra, pm_dec) plus optional kind / redshift.

    1) Local aliases (challenge targets + common names, with proper motion when known)
    2) In parallel: NASA/IPAC NED, SIMBAD (Harvard), and Gaia TAP (source-id queries)

    SIMBAD covers bright stars NED often misses (Deneb, Altair, …). Gaia TAP handles
    explicit Gaia DR3 source ids. Prefer SIMBAD/Gaia hits over NED when both succeed.

    Returns None when the name is unknown. Raises NameResolveUnavailable on outages.
    """
    query = name.strip()
    if not query:
        return None

    local = _local_name_hit(query)
    if local:
        return local

    (ned, ned_err), (sim, sim_err), (gaia, gaia_err) = await asyncio.gather(
        _safe_resolve(_ned_lookup(query)),
        _safe_resolve(_simbad_lookup(query)),
        _safe_resolve(_gaia_tap_by_id(query)),
    )

    # Messier / NGC / IC → prefer NED (cleaner galaxy identity). Else stars via Gaia/SIMBAD.
    if re.match(r"(?i)^(m|messier|ngc|ic)\s*\d+", query):
        order = (ned, sim, gaia)
    else:
        order = (gaia, sim, ned)
    for hit in order:
        if hit:
            return hit

    # At least one service answered "unknown" → not found.
    if ned_err is None or sim_err is None or gaia_err is None:
        return None

    raise NameResolveUnavailable(
        "Name lookup services did not respond (NED / SIMBAD / Gaia). "
        "Try again, enter RA/Dec, or use a challenge preset."
    ) from (sim_err or ned_err or gaia_err)


async def resolve_position(ra: float, dec: float):
    """RA/Dec → target dict. Prefer nearest NED object; fall back to coordinate label."""
    fallback = dict(
        name=f"{ra:.5f}, {dec:+.5f}",
        ra=ra,
        dec=dec,
        pm_ra=0.0,
        pm_dec=0.0,
        ref_epoch=2000.0,
        kind="Field",
        resolver="coords",
    )
    last: Exception | None = None
    for attempt in range(1, 3):
        try:
            hit = await _ned_cone(ra, dec)
            if not hit:
                return fallback
            # Keep the user's pointing as the cutout center; attach catalog identity.
            catalog_ra = hit["ra"]
            catalog_dec = hit["dec"]
            return {
                **hit,
                "ra": ra,
                "dec": dec,
                "catalog_ra": catalog_ra,
                "catalog_dec": catalog_dec,
            }
        except (httpx.TransportError, httpx.TimeoutException, httpx.HTTPStatusError) as e:
            last = e
            if attempt < 2:
                await asyncio.sleep(1.0 * attempt)
    return fallback


def propagate(target, year):
    """Apply proper motion from ref_epoch to `year` (good enough for small motions)."""
    dt = year - target.get("ref_epoch", 2000.0)
    dec = target["dec"] + target.get("pm_dec", 0) * dt / 3.6e6
    ra = target["ra"] + target.get("pm_ra", 0) * dt / 3.6e6 / math.cos(math.radians(dec))
    return ra % 360, dec


def target_public(target: dict, ra0: float, dec0: float) -> dict:
    """Slim target payload for the job result / frontend."""
    out = {
        "name": target.get("name") or f"{ra0:.5f}, {dec0:+.5f}",
        "ra": ra0,
        "dec": dec0,
        "kind": target.get("kind"),
        "obj_type": target.get("obj_type"),
        "redshift": target.get("redshift"),
        "resolver": target.get("resolver"),
        "separation_arcsec": target.get("separation_arcsec"),
        "gaia_source_id": target.get("gaia_source_id"),
        "description": target.get("description"),
    }
    return {k: v for k, v in out.items() if v is not None}


def _looks_named(name: str | None) -> bool:
    """True for human object names; false for bare coordinate labels."""
    if not name:
        return False
    s = name.strip()
    if re.fullmatch(r"[+-]?\d+(?:\.\d+)?\s*,\s*[+-]?\d+(?:\.\d+)?", s):
        return False
    if re.fullmatch(r"[+-]?\d+(?:\.\d+)?\s+[+-]?\d+(?:\.\d+)?", s):
        return False
    return len(s) >= 2


def _trim_blurb(text: str, max_chars: int = 240) -> str:
    text = re.sub(r"\s+", " ", (text or "").strip())
    if not text:
        return ""
    # Prefer 1–2 sentences.
    parts = re.split(r"(?<=[.!?])\s+", text)
    out = parts[0]
    if len(parts) > 1 and len(out) + 1 + len(parts[1]) <= max_chars:
        out = f"{out} {parts[1]}"
    if len(out) > max_chars:
        cut = out[: max_chars - 1].rsplit(" ", 1)[0]
        out = f"{cut}…"
    return out


def _pm_total_mas(target: dict) -> float:
    try:
        pra = float(target.get("pm_ra") or 0.0)
        pdec = float(target.get("pm_dec") or 0.0)
    except (TypeError, ValueError):
        return 0.0
    return math.hypot(pra, pdec)


def _blink_hint(target: dict) -> str | None:
    """Short SPHEREx-blink cue, matching the tone of the challenge presets."""
    kind = (target.get("kind") or "").lower()
    pm = _pm_total_mas(target)
    if pm >= 200:
        return "High proper motion — it should walk between survey passes."
    if pm >= 40:
        return "A modest proper motion — watch for a small shift between visits."
    if any(k in kind for k in ("variable", "young star", "cepheid", "mira")):
        return "Likely stays put; brightness may change more than place."
    if "galaxy" in kind or "quasar" in kind or "cluster" in kind:
        return "Fixed on the sky — blink for neighbors and structure, not a walk."
    if "brown dwarf" in kind:
        return "Nearby brown dwarfs often drift — compare survey passes carefully."
    if kind in {"star", "nearby star"} and pm < 40:
        return "Most distant stars hold still across SPHEREx visits."
    return None


def _is_catalog_noise_name(name: str) -> bool:
    """WISEA / 2MASS / X-ray IDs rarely have useful Wikipedia pages."""
    return bool(
        re.match(
            r"(?i)^(wisea|wise |2mass|2masx|2cxo|cxo |rx |ztf|gaia dr|sdss|panstarrs|ulas)",
            name.strip(),
        )
        or "[" in name
    )


def catalog_blurb(target: dict) -> str:
    """Specific prose when Wikipedia has no page for this name."""
    name = (target.get("name") or "This field").strip()
    kind = (target.get("kind") or "").strip()
    kind_l = kind.lower()
    obj_type = (target.get("obj_type") or "").strip()
    resolver = (target.get("resolver") or "").strip()
    sep = target.get("separation_arcsec")
    z = target.get("redshift")
    pm = _pm_total_mas(target)
    ra = float(target.get("ra") or 0.0)
    dec = float(target.get("dec") or 0.0)

    if not _looks_named(name) or resolver == "coords":
        return (
            f"An unmarked field at RA {ra:.5f}°, Dec {dec:+.5f}°. "
            "No nearby catalog name — open sky for whatever the blink turns up."
        )

    if "brown dwarf" in kind_l:
        lead = f"{name} is a brown dwarf"
    elif "galaxy" in kind_l or obj_type in {"G", "GiP", "GiC"}:
        lead = f"{name} is a galaxy"
    elif "quasar" in kind_l:
        lead = f"{name} is a quasar"
    elif "nebula" in kind_l or obj_type in {"HII", "PN", "SNR", "Neb"}:
        lead = f"{name} is a nebula / H II region"
    elif "variable" in kind_l:
        lead = f"{name} is a variable star"
    elif "young" in kind_l:
        lead = f"{name} is a young star"
    elif kind_l in {"star", "nearby star"} or "star" in kind_l or obj_type in {"*", "V*", "**"}:
        lead = f"{name} is a star"
    elif obj_type in {"IrS", "RadioS", "XrayS"} or _is_catalog_noise_name(name):
        lead = (
            f"{name} is a catalog detection"
            f"{f' ({obj_type})' if obj_type else ''} near RA {ra:.5f}°, Dec {dec:+.5f}°"
        )
    elif kind and kind_l not in {"field", "other", "unknown"}:
        lead = f"{name} is a {kind_l}"
    else:
        lead = f"{name} is listed in the sky catalogs"

    extras: list[str] = []
    if z is not None:
        try:
            zf = float(z)
            if math.isfinite(zf) and abs(zf) > 1e-5:
                extras.append(f"redshift z ≈ {zf:.4g}")
        except (TypeError, ValueError):
            pass
    if sep is not None:
        try:
            sep_f = float(sep)
            if sep_f > 0.05:
                extras.append(f"{sep_f:.1f}″ from your pointing")
        except (TypeError, ValueError):
            pass
    if pm >= 200:
        extras.append(f"proper motion ~{pm:.0f} mas/yr")
    elif pm >= 40:
        extras.append(f"proper motion ~{pm:.0f} mas/yr")
    if target.get("gaia_source_id"):
        extras.append(f"Gaia DR3 {target['gaia_source_id']}")

    if extras:
        return f"{lead} ({'; '.join(extras)})."
    return f"{lead}."


def _messier_number(name: str) -> int | None:
    """Parse Messier / M designations, including padded forms like MESSIER 030."""
    m = re.fullmatch(r"(?i)\s*(?:messier|m)\s*0*(\d{1,3})\s*", name.strip())
    return int(m.group(1)) if m else None


def _ngc_number(name: str) -> int | None:
    m = re.fullmatch(r"(?i)\s*ngc\s*0*(\d{1,4})\s*", name.strip())
    return int(m.group(1)) if m else None


def _wikipedia_title_candidates(name: str) -> list[str]:
    """Titles to try against Wikipedia for common astronomy shorthand."""
    title = name.strip()
    out: list[str] = []
    messier = _messier_number(title)
    ngc = _ngc_number(title)
    # Prefer canonical catalog titles first so padded names (MESSIER 030) do not
    # fall through to a fuzzy search that can land on the wrong object.
    if messier is not None:
        out.append(f"Messier {messier}")
        out.append(f"M{messier}")
    if ngc is not None:
        out.append(f"NGC {ngc}")
    if title and not _is_catalog_noise_name(title):
        out.append(title)
    # Dedupe while preserving order.
    seen: set[str] = set()
    uniq: list[str] = []
    for t in out:
        key = t.casefold()
        if key not in seen:
            seen.add(key)
            uniq.append(t)
    return uniq


def _wikipedia_title_matches_query(query: str, title: str) -> bool:
    """Reject fuzzy search hits that point at a different catalog object."""
    q_m = _messier_number(query)
    t_m = _messier_number(title)
    if q_m is not None:
        return t_m == q_m
    q_n = _ngc_number(query)
    t_n = _ngc_number(title)
    if q_n is not None:
        return t_n == q_n
    # For free-form names, require the query token to appear in the page title.
    q = re.sub(r"\s+", " ", query.strip().casefold())
    t = title.strip().casefold()
    return bool(q) and (q in t or t in q)


_WIKI_HEADERS = {
    "User-Agent": (
        "FlickeringPixels/1.0 "
        "(https://www.spaceappschallenge.org/2026/find-a-team/flickering-pixels/; "
        "NASA Space Apps SPHEREx blink tool)"
    ),
    "Accept": "application/json",
}


async def _wikipedia_summary(name: str) -> str | None:
    """Short plain-language extract from Wikipedia (no API key)."""
    from urllib.parse import quote

    timeout = httpx.Timeout(connect=4.0, read=6.0, write=4.0, pool=4.0)
    for title in _wikipedia_title_candidates(name):
        try:
            r = await _client.get(
                f"https://en.wikipedia.org/api/rest_v1/page/summary/{quote(title, safe='')}",
                headers=_WIKI_HEADERS,
                timeout=timeout,
                follow_redirects=True,
            )
        except Exception:
            continue
        if r.status_code >= 400:
            continue
        try:
            data = r.json()
        except Exception:
            continue
        if data.get("type") == "disambiguation":
            continue
        extract = (data.get("extract") or "").strip()
        if extract:
            return _trim_blurb(extract, max_chars=260)
    return None


async def _wikipedia_search_summary(name: str) -> str | None:
    """Fallback: MediaWiki opensearch → summary (helps odd catalog spellings)."""
    if _is_catalog_noise_name(name):
        return None
    # Search with the canonical catalog form when we have one.
    search_terms = _wikipedia_title_candidates(name) or [name.strip()]
    timeout = httpx.Timeout(connect=4.0, read=6.0, write=4.0, pool=4.0)
    for term in search_terms:
        try:
            r = await _client.get(
                "https://en.wikipedia.org/w/api.php",
                params={
                    "action": "opensearch",
                    "search": term,
                    "limit": 5,
                    "namespace": 0,
                    "format": "json",
                },
                headers=_WIKI_HEADERS,
                timeout=timeout,
            )
            r.raise_for_status()
            data = r.json()
            titles = data[1] if isinstance(data, list) and len(data) > 1 else []
            for title in titles:
                if not _wikipedia_title_matches_query(name, title) and not _wikipedia_title_matches_query(
                    term, title
                ):
                    continue
                summary = await _wikipedia_summary(title)
                if summary:
                    return summary
        except Exception:
            continue
    return None


async def wiki_blurb(target: dict) -> str | None:
    """Wikipedia summary for a named target, or None when there is no page."""
    name = (target.get("name") or "").strip()
    if not _looks_named(name) or target.get("resolver") == "coords":
        return None
    try:
        text = await _wikipedia_summary(name) or await _wikipedia_search_summary(name)
    except Exception:
        return None
    return _trim_blurb(text, max_chars=300) if text else None


async def describe_target(target: dict) -> str:
    """Specific 1–2 sentence Object-tab blurb (Wikipedia + catalog facts)."""
    wiki = await wiki_blurb(target)
    base = wiki or catalog_blurb(target)
    hint = _blink_hint(target)
    # On Wikipedia extracts, only add motion cues (presets-style), not "fixed on sky" filler.
    if wiki:
        pm = _pm_total_mas(target)
        if hint and pm >= 40 and hint.lower() not in base.lower():
            return _trim_blurb(f"{base.rstrip('. ')}. {hint}", max_chars=300)
        return _trim_blurb(base, max_chars=300)
    if hint and hint.lower() not in base.lower():
        return _trim_blurb(f"{base.rstrip('. ')}. {hint}", max_chars=300)
    return _trim_blurb(base, max_chars=300)


# ── Catalog motion: Gaia DR3 stars and known asteroids in a field ─────────────

# US mirror of CDS VizieR (the Strasbourg / ESA services are often unreachable).
VIZIER_ASU = "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv"
SKYBOT_URL = "https://ssp.imcce.fr/webservices/skybot/api/conesearch.php"
HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
_catalog_timeout = httpx.Timeout(connect=8.0, read=25.0, write=8.0, pool=8.0)


def _parse_asu_tsv(text):
    """VizieR ASU TSV → list of dicts (skips comments, the units row and the dashes row)."""
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
    if len(lines) < 3:
        return []
    head = [h.strip() for h in lines[0].split("\t")]
    out = []
    for ln in lines[3:]:
        vals = [v.strip() for v in ln.split("\t")]
        if len(vals) == len(head):
            out.append(dict(zip(head, vals)))
    return out


async def gaia_movers(ra, dec, radius_deg, min_pm_mas=30.0, limit=40):
    """Gaia DR3 stars in a cone with total proper motion above ``min_pm_mas`` (mas/yr),
    fastest first. Positions are at Gaia's epoch J2016.0."""
    r = await _client.get(VIZIER_ASU, params={
        "-source": "I/355/gaiadr3",
        "-c": f"{ra:.6f} {dec:+.6f}",
        "-c.rd": f"{radius_deg:.4f}",
        "-out": "Source,RA_ICRS,DE_ICRS,pmRA,pmDE,e_pmRA,e_pmDE,Gmag,PM",
        "PM": f">{min_pm_mas:g}",
        "-sort": "-PM",
        "-out.max": str(limit),
    }, timeout=_catalog_timeout)
    r.raise_for_status()
    stars = []
    for row in _parse_asu_tsv(r.text):
        try:
            stars.append(dict(
                source_id=row["Source"], ra=float(row["RA_ICRS"]), dec=float(row["DE_ICRS"]),
                pm_ra=float(row["pmRA"]), pm_dec=float(row["pmDE"]),
                e_pm=math.hypot(float(row["e_pmRA"] or 0), float(row["e_pmDE"] or 0)),
                gmag=float(row["Gmag"]) if row.get("Gmag") else None,
                ref_epoch=2016.0,
            ))
        except (KeyError, ValueError):
            continue
    return stars


def _sexa(value, hours):
    parts = [float(p) for p in value.replace(":", " ").split()]
    sign = -1 if value.strip().startswith("-") else 1
    deg = abs(parts[0]) + (parts[1] if len(parts) > 1 else 0) / 60 + (parts[2] if len(parts) > 2 else 0) / 3600
    return sign * deg * (15 if hours else 1)


async def skybot_asteroids(ra, dec, radius_deg, jd):
    """Known solar-system objects inside a cone at one moment (IMCCE SkyBoT)."""
    r = await _client.get(SKYBOT_URL, params={
        "-ep": f"{jd:.5f}", "-ra": f"{ra:.6f}", "-dec": f"{dec:+.6f}", "-rd": f"{radius_deg:.4f}",
        "-mime": "json", "-output": "basic", "-loc": "500",
    }, timeout=_catalog_timeout)
    r.raise_for_status()
    try:
        data = r.json()
    except ValueError:
        return []  # SkyBoT answers with a plain-text note when nothing is in the field
    out = []
    for row in data if isinstance(data, list) else []:
        try:
            out.append(dict(
                name=row["Name"], ra=_sexa(row["RA (hms)"], True), dec=_sexa(row["DEC (dms)"], False),
                vmag=row.get("VMag (mag)"), kind=row.get("Class") or "asteroid",
                dra_arcsec_h=float(row.get("dRA (arcsec/h)") or 0),
                ddec_arcsec_h=float(row.get("dDEC (arcsec/h)") or 0),
            ))
        except (KeyError, ValueError):
            continue
    return out


async def horizons_position(name, jd):
    """Geocentric RA/Dec of a solar-system object at ``jd`` from JPL Horizons, or None."""
    provisional = re.fullmatch(r"\d{4} [A-Z]{2}\d*", name.strip())
    command = f"DES={name};" if provisional else f"{name};"
    r = await _client.get(HORIZONS_URL, params={
        "format": "text", "COMMAND": f"'{command}'", "OBJ_DATA": "NO", "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "OBSERVER", "CENTER": "'500@399'", "TLIST": f"'{jd:.5f}'",
        "QUANTITIES": "'1'", "ANG_FORMAT": "DEG",
    }, timeout=_catalog_timeout)
    r.raise_for_status()
    m = re.search(r"\$\$SOE\s*(.*?)\s*\$\$EOE", r.text, re.S)
    if not m:
        return None
    nums = re.findall(r"[-+]?\d+\.\d+", m.group(1).splitlines()[0])
    if len(nums) < 3:
        return None
    return float(nums[-2]), float(nums[-1])
