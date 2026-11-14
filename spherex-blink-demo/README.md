# SPHEREx Blink — throwaway prototype

> **Feasibility spike for NASA Space Apps 2026 – "Planet X and SPHEREx".**
> Built before the hackathon only to prove the official API works and to show the team what the
> feature ideas look like. Per the Space Apps rules, the real project is rebuilt from scratch on Nov 14.

Type a sky position (or click a challenge target). The app pulls every SPHEREx image of that patch from
NASA/IPAC IRSA, aligns them, and shows:

1. **Blink**: the 6‑month survey passes (all detectors stacked for S/N) played as an animation,
   or every individual frame, or a **difference image** (moving objects → black/white pair).
   The orange circle marks where proper motion says the target should be at each pass.
2. **Infrared colour**: an RGB image built from the 6 detectors (blue = 0.75–1.6 µm … red = 3.8–5 µm),
   plus a stacked thumbnail per detector.
3. **Spectrum on click**: click any pixel. The app measures that sky position in every frame, using
   SPHEREx's per‑pixel wavelength map, and plots flux vs wavelength (0.75–5 µm), coloured by date.
4. **Context**: Aladin Lite with 2MASS imagery and Gaia DR3 + AllWISE catalog overlays.

URL parameters make it embeddable: `/?ra=269.446&dec=4.768&fov=0.12` or `/?preset=barnard`.

## Run

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app:app --port 8000
# open http://localhost:8000/?preset=barnard
```

By default the tool loads every SPHEREx cutout covering the target (cached in `cache/` after the
first pull). Set `SPHEREX_MAX_FRAMES` to a positive number to thin for faster demos; concurrency is
`SPHEREX_CONCURRENCY`. The blink timeline shows survey passes (~6 months apart), not every frame.

## Official APIs used

| What | Endpoint |
|---|---|
| Find images covering a point | `https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_qr2&POS=circle RA DEC 0.001&RESPONSEFORMAT=CSV` |
| Cut a small piece out of one image | `<access_url>?center=RA,DEC&size=DEG` (returns FITS: IMAGE, FLAGS, VARIANCE, ZODI, PSF, WCS-WAVE) |
| Which releases exist | IRSA TAP: `SELECT DISTINCT obs_collection FROM ivoa.obscore WHERE obs_collection LIKE 'spherex%'` |
| Name → coordinates (optional) | NASA/IPAC NED ObjectLookup (+ local aliases for challenge stars) |

**New data release?** Add the collection name (e.g. `spherex_qr4`) to `COLLECTIONS` in `config.py`.

IRSA sends no CORS headers, so the browser can't call it directly. `app.py` is the proxy.

## Code map

- `config.py`: releases, presets (with proper motions), flag bits, limits
- `irsa.py`: SIA search, cached cutout download (PSF extension dropped), name resolve, proper motion
- `processing.py`: reprojection to a common north‑up grid, zodi/background removal, flag masking,
  S/N stacking, PNG stretch, difference, RGB, spectrum
- `app.py`: FastAPI. `POST /api/load` starts a job; `GET /api/job/{id}` reports progress/result;
  `/png/{name}`, `/diff?a&b` and `/spectrum?x&y` serve the outputs
- `static/`: plain HTML/JS/CSS, no build step

## Known limitations / ideas for the real build

- Frames are thinned to 72 per target; a real build could pre‑compute stacks or fetch progressively.
- Each cutout includes a ~5 MB PSF cube we throw away. Ask IRSA whether extensions can be skipped.
- Very bright stars overflow the detector. Barnard's Star and R Draconis get no spectrum at their centre (the page says so);
  their images are filled from neighbouring pixels for display only. Measuring them would need photometry on the unsaturated PSF wings.
- Spectrum is a 3×3 pixel sum in MJy/sr with no PSF photometry or error bars (VARIANCE is available).
- Ideas: sub‑pixel shift‑and‑stack along a trial motion vector to find faint movers; flag overlays;
  QR3 "deep" collections; Gaia positions propagated to each epoch drawn on the blink.
