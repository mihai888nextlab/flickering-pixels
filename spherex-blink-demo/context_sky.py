"""Sky-context helpers: Gaia / AllWISE cone searches via IRSA (works when CDS is down)."""

from __future__ import annotations

import csv
import io
from concurrent.futures import ThreadPoolExecutor

import httpx

IRSA_SCS = "https://irsa.ipac.caltech.edu/SCS"
USER_AGENT = "FlickeringPixels/1.0 (NASA Space Apps)"
_TIMEOUT = httpx.Timeout(connect=15.0, read=40.0, write=15.0, pool=15.0)


def _fetch_scs_csv(table: str, ra: float, dec: float, radius_deg: float) -> str:
    params = {
        "table": table,
        "RA": f"{ra:.8f}",
        "DEC": f"{dec:.8f}",
        "SR": f"{max(radius_deg, 0.01):.6f}",
        "FORMAT": "CSV",
    }
    last_err: Exception | None = None
    # httpx uses certifi's CA bundle (urllib on macOS often cannot verify IRSA).
    with httpx.Client(timeout=_TIMEOUT, headers={"User-Agent": USER_AGENT}, follow_redirects=True) as client:
        for attempt in range(3):
            try:
                resp = client.get(IRSA_SCS, params=params)
                resp.raise_for_status()
                return resp.text
            except Exception as err:
                last_err = err
        raise RuntimeError(str(last_err) if last_err else "IRSA request failed")


def _rows(csv_text: str) -> list[dict[str, str]]:
    lines = []
    for line in csv_text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("<?xml"):
            continue
        lines.append(line)
    if not lines:
        return []
    reader = csv.DictReader(io.StringIO("\n".join(lines)))
    return [dict(row) for row in reader if row]


def _num(row: dict[str, str], *keys: str) -> float | None:
    for key in keys:
        raw = row.get(key)
        if raw is None or raw == "":
            continue
        try:
            return float(raw)
        except ValueError:
            continue
    return None


def gaia_sources(ra: float, dec: float, radius_deg: float, limit: int = 180) -> list[dict]:
    try:
        text = _fetch_scs_csv("gaia_dr3_source", ra, dec, radius_deg)
    except Exception as err:
        raise RuntimeError(f"Gaia IRSA query failed: {err}") from err
    out: list[dict] = []
    for row in _rows(text):
        r = _num(row, "ra", "RA")
        d = _num(row, "dec", "DEC")
        if r is None or d is None:
            continue
        mag = _num(row, "phot_g_mean_mag")
        name = row.get("designation") or row.get("source_id") or "Gaia"
        out.append(
            {
                "ra": r,
                "dec": d,
                "name": str(name),
                "mag": mag,
                "catalog": "Gaia DR3",
            }
        )
        if len(out) >= limit:
            break
    return out


def allwise_sources(ra: float, dec: float, radius_deg: float, limit: int = 180) -> list[dict]:
    try:
        text = _fetch_scs_csv("allwise_p3as_psd", ra, dec, radius_deg)
    except Exception as err:
        raise RuntimeError(f"AllWISE IRSA query failed: {err}") from err
    out: list[dict] = []
    for row in _rows(text):
        r = _num(row, "ra", "RA")
        d = _num(row, "dec", "DEC")
        if r is None or d is None:
            continue
        w1 = _num(row, "w1mpro")
        name = row.get("designation") or row.get("source_id") or "AllWISE"
        out.append(
            {
                "ra": r,
                "dec": d,
                "name": str(name),
                "mag": w1,
                "w1": w1,
                "w2": _num(row, "w2mpro"),
                "catalog": "AllWISE",
            }
        )
        if len(out) >= limit:
            break
    return out


def sky_catalogs(ra: float, dec: float, radius_deg: float, gaia: bool = True, wise: bool = True) -> dict:
    """Return catalogue markers for Aladin; uses IRSA SCS (not CDS VizieR)."""
    payload: dict = {
        "ra": ra,
        "dec": dec,
        "radius_deg": radius_deg,
        "gaia": [],
        "allwise": [],
        "errors": [],
    }

    def load_gaia():
        return gaia_sources(ra, dec, radius_deg) if gaia else []

    def load_wise():
        return allwise_sources(ra, dec, radius_deg) if wise else []

    with ThreadPoolExecutor(max_workers=2) as pool:
        fut_g = pool.submit(load_gaia)
        fut_w = pool.submit(load_wise)
        try:
            payload["gaia"] = fut_g.result()
        except RuntimeError as err:
            payload["errors"].append(str(err))
        try:
            payload["allwise"] = fut_w.result()
        except RuntimeError as err:
            payload["errors"].append(str(err))
    return payload
