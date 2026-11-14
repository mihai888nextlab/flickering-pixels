const $ = (id) => document.getElementById(id);
const state = { job: null, result: null, mode: "epochs", idx: 0, playing: true, timer: null, cfg: null, aladin: null };

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}
const pngUrl = (name) => `/api/job/${state.job}/png/${name}`;

function setStatus(html, err = false) { $("status").innerHTML = html; $("status").classList.toggle("err", err); }

// ---------- setup ----------
async function init() {
  state.cfg = await api("/api/config");
  $("presets").innerHTML = Object.entries(state.cfg.presets)
    .map(([k, p]) => `<button data-preset="${k}">${p.name}</button>`).join(" ");
  $("colls").innerHTML = state.cfg.collections.map((c) =>
    `<label><input type="checkbox" name="coll" value="${c}" ${state.cfg.default_collections.includes(c) ? "checked" : ""}>${c.replace("spherex_", "").toUpperCase()}</label>`).join(" ");

  $("fov").oninput = () => ($("fovOut").textContent = (+$("fov").value).toFixed(2) + "°");
  $("presets").onclick = (e) => {
    const k = e.target.dataset.preset;
    if (!k) return;
    const p = state.cfg.presets[k];
    $("ra").value = p.ra.toFixed(5); $("dec").value = p.dec.toFixed(5); $("fov").value = p.fov; $("fov").oninput();
    load({ preset: k, fov: p.fov });
  };
  $("form").onsubmit = (e) => { e.preventDefault(); load({ ra: +$("ra").value, dec: +$("dec").value, fov: +$("fov").value }); };
  $("nameForm").onsubmit = async (e) => {
    e.preventDefault();
    setStatus("Resolving name via NASA/IPAC NED…");
    try {
      const t = await api(`/api/resolve?name=${encodeURIComponent($("name").value)}`);
      $("ra").value = t.ra_2026.toFixed(5); $("dec").value = t.dec_2026.toFixed(5);
      load({ ra: t.ra_2026, dec: t.dec_2026, fov: +$("fov").value });
    } catch (err) { setStatus(err.message, true); }
  };

  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $("play").onclick = () => { state.playing = !state.playing; $("play").textContent = state.playing ? "⏸ Pause" : "▶ Play"; schedule(); };
  $("speed").oninput = schedule;
  $("scrub").oninput = () => { state.idx = +$("scrub").value; show(); };
  $("diffA").onchange = $("diffB").onchange = showDiff;
  $("viewer").onclick = clickSpectrum;

  // URL → initial load (embeddable)
  const q = new URLSearchParams(location.search);
  if (q.get("preset") && state.cfg.presets[q.get("preset")]) {
    document.querySelector(`[data-preset="${q.get("preset")}"]`).click();
  } else if (q.get("ra") && q.get("dec")) {
    $("ra").value = q.get("ra"); $("dec").value = q.get("dec");
    if (q.get("fov")) { $("fov").value = q.get("fov"); $("fov").oninput(); }
    $("form").requestSubmit();
  } else {
    setStatus("Pick a challenge target or enter coordinates.");
  }
}

// ---------- loading ----------
async function load(body) {
  body.collections = [...document.querySelectorAll("input[name=coll]:checked")].map((c) => c.value);
  const q = body.preset ? `?preset=${body.preset}` : `?ra=${body.ra}&dec=${body.dec}&fov=${body.fov}`;
  history.replaceState(null, "", q);
  setStatus("Searching the SPHEREx archive…");
  try {
    const { job } = await api("/api/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    state.job = job;
    poll(job);
  } catch (err) { setStatus(err.message, true); }
}

async function poll(job) {
  if (job !== state.job) return;
  const s = await api(`/api/job/${job}`);
  if (s.status === "error") return setStatus(s.error, true);
  if (s.status === "done") return render(s.result);
  const pct = s.total ? Math.round((100 * s.done) / s.total) : 0;
  const msg = { searching: "Searching the SPHEREx archive…", downloading: `Downloading cutouts from IRSA: ${s.done}/${s.total}`, processing: "Aligning and stacking images…" }[s.status];
  setStatus(`${msg}<div class="bar"><div style="width:${s.status === "processing" ? 100 : pct}%"></div></div>`);
  setTimeout(() => poll(job), 1000);
}

// ---------- rendering ----------
function render(r) {
  state.result = r;
  $("panels").hidden = false;
  const span = r.epochs.length ? `${r.epochs[0].start} → ${r.epochs.at(-1).end}` : "";
  setStatus(`<b>${r.target.name}</b> · RA ${r.target.ra.toFixed(5)}°, Dec ${r.target.dec.toFixed(5)}° · ` +
    `${r.n_found} SPHEREx images found, ${r.n_used} used · ${r.epochs.length} survey passes · ${span}`);

  const opts = r.epochs.map((e, i) => `<option value="${i}">${i + 1}: ${e.start}</option>`).join("");
  $("diffA").innerHTML = $("diffB").innerHTML = opts;
  $("diffB").value = Math.max(0, r.epochs.length - 1);

  $("rgbImg").src = r.rgb ? pngUrl(r.rgb) : "";
  $("dets").innerHTML = r.detectors.map((d) =>
    `<figure><img src="${pngUrl(d.png)}" alt="D${d.detector}"><figcaption>D${d.detector} · ${d.band}<br>${d.n} frames</figcaption></figure>`).join("");

  $("spec").innerHTML = ""; $("specMeta").textContent = "Click a pixel in the Blink panel.";
  setMode(r.epochs.length > 1 ? "epochs" : "frames");
  // preload images so blinking is smooth
  [...r.epochs, ...r.frames].forEach((f) => { new Image().src = pngUrl(f.png); });
  showAladin(r.target.ra, r.target.dec, r.fov);
}

function list() { return state.mode === "frames" ? state.result.frames : state.result.epochs; }

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("blinkCtl").hidden = mode === "diff";
  $("diffCtl").hidden = mode !== "diff";
  if (mode === "diff") { clearTimeout(state.timer); return showDiff(); }
  state.idx = 0;
  $("scrub").max = Math.max(0, list().length - 1);
  show(); schedule();
}

function show() {
  const items = list();
  if (!items.length) { $("frameMeta").textContent = "No frames."; return; }
  const f = items[state.idx % items.length];
  $("blinkImg").src = pngUrl(f.png);
  $("scrub").value = state.idx % items.length;
  const pm = $("pmMarker");
  if (state.mode === "epochs") {
    $("frameMeta").innerHTML = `Pass <b>${state.idx % items.length + 1}/${items.length}</b> · <b>${f.start}</b> → ${f.end} · ${f.n} frames stacked (all 6 detectors)`;
    const n = state.result.npix;
    pm.style.display = "block";
    pm.style.left = `${(100 * (f.target_px[0] + 0.5)) / n}%`;
    pm.style.top = `${(100 * (f.target_px[1] + 0.5)) / n}%`;
  } else {
    pm.style.display = "none";
    $("frameMeta").innerHTML = `Frame <b>${state.idx % items.length + 1}/${items.length}</b> · <b>${f.date}</b> · detector D${f.detector} (${f.band}) · ` +
      `${f.collection.replace("spherex_", "").toUpperCase()} · ${f.obs_id} · <span title="fraction of flagged pixels">flags ${(100 * f.flagged).toFixed(1)}%</span>`;
  }
}

function schedule() {
  clearTimeout(state.timer);
  if (!state.playing || state.mode === "diff") return;
  state.timer = setTimeout(() => { state.idx = (state.idx + 1) % list().length; show(); schedule(); }, +$("speed").max + +$("speed").min - +$("speed").value);
}

function showDiff() {
  const a = $("diffA").value, b = $("diffB").value;
  $("pmMarker").style.display = "none";
  $("blinkImg").src = `/api/job/${state.job}/diff?a=${a}&b=${b}`;
  const E = state.result.epochs;
  $("frameMeta").innerHTML = E.length < 2 ? "Need at least 2 survey passes for a difference." :
    `<b>${E[b].start}</b> minus <b>${E[a].start}</b>. Things that moved show up as a black/white pair.`;
}

// ---------- spectrum ----------
async function clickSpectrum(e) {
  if (!state.result) return;
  const box = $("viewer").getBoundingClientRect(), n = state.result.npix;
  const x = ((e.clientX - box.left) / box.width) * n - 0.5, y = ((e.clientY - box.top) / box.height) * n - 0.5;
  $("specMeta").textContent = "Measuring this spot in every frame…";
  const s = await api(`/api/job/${state.job}/spectrum?x=${x}&y=${y}`);
  drawSpectrum(s);
}

function drawSpectrum(s) {
  const P = s.points, svg = $("spec"), W = 520, H = 300, m = { l: 52, r: 12, t: 12, b: 36 };
  const rejectedNote = s.rejected ? ` ${s.rejected} frames skipped because a pixel here is flagged.` : "";
  if (!P.length) {
    svg.innerHTML = "";
    $("specMeta").textContent = s.rejected
      ? `No usable measurement: all ${s.rejected} frames covering this spot have flagged pixels. Very bright stars overflow the detector, so their centres cannot be measured. Try a fainter source.`
      : "This spot is outside the images.";
    return;
  }
  const xs = P.map((p) => p.wavelength_um), ys = P.map((p) => p.flux);
  const x0 = 0.7, x1 = 5.1, y0 = Math.min(0, ...ys), y1 = Math.max(...ys) * 1.1 || 1;
  const X = (v) => m.l + ((v - x0) / (x1 - x0)) * (W - m.l - m.r), Y = (v) => H - m.b - ((v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const colors = ["#6cb6ff", "#7ee787", "#ffb454", "#ff7b72", "#d2a8ff", "#f2cc60"];
  // Colour by survey pass (dates more than 60 days apart), so each pass gets its own colour.
  const days = (d) => Date.parse(d) / 864e5;
  const passes = [];
  [...new Set(P.map((p) => p.date))].sort().forEach((d) => {
    const cur = passes.at(-1);
    if (cur && days(d) - days(cur.end) <= 60) cur.end = d;
    else passes.push({ start: d, end: d });
  });
  const passOf = (d) => passes.findIndex((q) => d >= q.start && d <= q.end);
  let g = `<line x1="${m.l}" y1="${H - m.b}" x2="${W - m.r}" y2="${H - m.b}" stroke="#232b3d"/>`;
  for (let t = 1; t <= 5; t++) g += `<text x="${X(t)}" y="${H - m.b + 16}" text-anchor="middle">${t} µm</text>`;
  g += `<text x="${m.l - 6}" y="${Y(y1 / 1.1)}" text-anchor="end">${(y1 / 1.1).toPrecision(2)}</text><text x="${m.l - 6}" y="${Y(0)}" text-anchor="end">0</text>`;
  g += `<text x="12" y="${H / 2}" transform="rotate(-90 12 ${H / 2})" text-anchor="middle">MJy/sr (3×3 px)</text>`;
  g += P.map((p) => `<circle cx="${X(p.wavelength_um)}" cy="${Y(p.flux)}" r="3.2" fill="${colors[passOf(p.date) % colors.length]}"><title>${p.wavelength_um} µm · ${p.flux.toFixed(2)} · ${p.date} · D${p.detector}</title></circle>`).join("");
  svg.innerHTML = g;
  $("specMeta").innerHTML = `RA ${s.ra.toFixed(5)}°, Dec ${s.dec.toFixed(5)}° · ${P.length} measurements.${rejectedNote}<br>` +
    passes.map((q, i) => `<span style="color:${colors[i % colors.length]}">●</span> ${q.start.slice(0, 7)}`).join(" &nbsp; ") +
    `<br>A brightness change at the same wavelength between passes means variability.`;
}

// ---------- Aladin ----------
function showAladin(ra, dec, fov) {
  if (!window.A) {  // module script still loading
    window.addEventListener("aladin-ready", () => showAladin(ra, dec, fov), { once: true });
    return;
  }
  A.init.then(() => {
    if (!state.aladin) {
      state.aladin = A.aladin("#aladin", { survey: "P/2MASS/color", fov: fov * 1.2, target: `${ra} ${dec}`, showReticle: true, showCooGrid: false });
    } else {
      state.aladin.gotoRaDec(ra, dec); state.aladin.setFoV(fov * 1.2); state.aladin.removeLayers();
    }
    const r = Math.max(fov, 0.05);
    state.aladin.addCatalog(A.catalogFromVizieR("I/355/gaiadr3", `${ra} ${dec}`, r, { onClick: "showTable", color: "#ffb454", sourceSize: 10 }));
    state.aladin.addCatalog(A.catalogFromVizieR("II/328/allwise", `${ra} ${dec}`, r, { onClick: "showTable", color: "#39d0ff", sourceSize: 14, shape: "circle" }));
  }).catch((err) => { $("aladin").textContent = `Aladin Lite could not start: ${err}`; });
}

init();
