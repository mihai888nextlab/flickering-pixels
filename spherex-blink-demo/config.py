"""Settings for the SPHEREx blink demo. Add new data releases to COLLECTIONS."""
import os
from pathlib import Path

# IRSA collection names; each SPHEREx Quick Release is its own collection.
COLLECTIONS = ["spherex_qr2", "spherex_qr3", "spherex_dr1"]
# DR1 holds the earlier survey passes (2025 → spring 2026); without it most fields show a
# single pass, so blinking and motion tracking have nothing to compare.
DEFAULT_COLLECTIONS = ["spherex_qr2", "spherex_qr3", "spherex_dr1"]

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
# CDS Sesame is often unreachable from some networks; use IPAC NED instead.
NED_LOOKUP_URL = "https://ned.ipac.caltech.edu/srs/ObjectLookup"
NED_CONE_URL = "https://ned.ipac.caltech.edu/NED::API/ConeSearchByPosition"
# Arcmin radius when resolving bare RA/Dec to a nearest NED object.
NED_CONE_RADIUS_ARCMIN = 1.0
# Harvard SIMBAD mirror — resolves bright stars / common names NED often misses (e.g. Deneb).
# CDS Strasbourg is frequently blocked; CFA usually responds.
SIMBAD_ID_URL = "https://simbad.cfa.harvard.edu/simbad/sim-id"
# Gaia DR3 source-id → coords via ESA Gaia Archive TAP (slow; optional path).
GAIA_TAP_URL = "https://gea.esac.esa.int/tap-server/tap/sync"

CACHE_DIR = Path(os.environ.get("SPHEREX_CACHE", Path(__file__).parent / "cache"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Parallel cutouts — IRSA tolerates ~12–16; higher can trip 429/504.
MAX_CONCURRENT_DOWNLOADS = int(os.environ.get("SPHEREX_CONCURRENCY", 14))
# 0 = keep every SIA hit (no thinning). Positive = evenly sample down to that count.
MAX_FRAMES = int(os.environ.get("SPHEREX_MAX_FRAMES", "0"))
# Only applies when sampling (MAX_FRAMES > 0).
MAX_FRAMES_CAP = int(os.environ.get("SPHEREX_MAX_FRAMES_CAP", "500"))
PIXEL_SCALE_ARCSEC = 6.15
# Frames closer than this belong to the same survey pass (timeline “main” timestamps).
EPOCH_GAP_DAYS = 90

# Nominal SPHEREx detector windows (µm) for UI wavelength picking.
DETECTOR_BANDS = {
    1: {"label": "D1", "lo": 0.75, "hi": 1.11},
    2: {"label": "D2", "lo": 1.11, "hi": 1.63},
    3: {"label": "D3", "lo": 1.63, "hi": 2.42},
    4: {"label": "D4", "lo": 2.42, "hi": 3.82},
    5: {"label": "D5", "lo": 3.82, "hi": 4.42},
    6: {"label": "D6", "lo": 4.42, "hi": 5.00},
}

# FLAGS bits treated as bad pixels (see MP_* keywords in the FLAGS header).
BAD_FLAG_BITS = [0, 1, 2, 6, 7, 9, 10, 11, 15, 17, 19, 22, 23, 24, 26, 27]

# Pixels that can fake a moving object in a single-visit map tile (names from the MSKN
# keywords of the FLAGS header): TRANSIENT (cosmic rays), SUR_ERROR, NONFUNC, MISSING_DATA,
# HOT, COLD, PHANMISS, PERSIST, OUTLIER, CROSSTALK, GHOST, GHOST_FPA, GHOST_EXT, STREAK,
# SNOWBALL, HALO (transient halo). OVERFLOW, NONLINEAR and BLOOM are left out: they sit on
# real bright stars that every visit shows.
ARTIFACT_FLAG_BITS = [0, 2, 6, 9, 10, 11, 14, 17, 19, 20, 22, 23, 24, 25, 27, 28]

# Contamination / quality bits surfaced in Expert metadata (SPHEREx Explanatory Supplement).
# SOURCE is informative (known catalog source), not always "bad".
CONTAM_FLAG_BITS = {
    "overflow": 1,
    "nonlinear": 15,
    "persist": 17,
    "outlier": 19,
    "source": 21,
    "ghost": 22,
    "ghost_ext": 24,
    "bloom": 26,
    "snowball": 27,
    "halo": 28,
}

# Challenge test targets. Positions at ref_epoch (Julian year), proper motion in mas/yr
# (pm_ra includes cos(dec)). They are propagated to the observation date.
PRESETS = {
    "barnard": dict(name="Barnard's Star", ra=269.452077, dec=4.693391,
                    pm_ra=-801.6, pm_dec=10362.4, ref_epoch=2000.0, fov=0.12,
                    kind="Nearby star"),
    "eps_indi_b": dict(name="Epsilon Indi B", ra=331.04384, dec=-56.78269,
                       pm_ra=3982.0, pm_dec=-2470.0, ref_epoch=2000.0, fov=0.12,
                       kind="Brown dwarf"),
    "wise0855": dict(name="WISE 0855-0714", ra=133.795129, dec=-7.245147,
                     pm_ra=-8118.0, pm_dec=680.0, ref_epoch=2010.5, fov=0.12,
                     kind="Brown dwarf"),
    "rw_aur": dict(name="RW Aurigae", ra=76.95642, dec=30.40142,
                   pm_ra=4.0, pm_dec=-26.0, ref_epoch=2000.0, fov=0.1,
                   kind="Young star"),
    "r_dra": dict(name="R Draconis", ra=248.16738, dec=66.75497,
                  pm_ra=-8.0, pm_dec=-13.0, ref_epoch=2000.0, fov=0.1,
                  kind="Variable star"),
}
