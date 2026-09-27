"use strict";

// The demo backend (demo_server/). Empty = not deployed yet.
const DEMO_API = "https://sanjar--pipeline-web.modal.run";
const CHUNK = 4 * 1024 * 1024;      // upload chunk size
const PARALLEL = 8;                  // chunks in flight at once (a single stream to the server is slow)

const CLASSES = ["accident", "near_miss", "red_light", "wrong_way", "illegal_u_turn", "stopped_vehicle", "jaywalking",
  "failure_to_yield", "illegal_turn", "solid_line_crossing", "stop_line", "congestion", "road_obstacle", "fire_smoke"];
const CLASS_COLOUR = {
  accident: "#ff453a", near_miss: "#ff9f0a", red_light: "#e54666", wrong_way: "#d6409f", illegal_u_turn: "#ab4aba",
  illegal_turn: "#8e4ec6", solid_line_crossing: "#ffc53d", stop_line: "#f76b15", stopped_vehicle: "#0090ff",
  congestion: "#3e63dd", jaywalking: "#30a46c", failure_to_yield: "#12a594", road_obstacle: "#a18072", fire_smoke: "#ff6b3d",
};
const COUNT_CLASSES = [["car", "cars"], ["person", "people"], ["bus", "buses"], ["truck", "trucks"],
  ["motorcycle", "motorcycles"], ["bicycle", "bicycles"]];
const PERSON = 0;
const LAYERS = [
  { key: "boxes", label: "Road users", on: true },
  { key: "events", label: "Events", on: true },
  { key: "signal", label: "Signal", on: true },
  { key: "crossings", label: "Crossings", on: true },
  { key: "stopline", label: "Stop line", on: true },
  { key: "lines", label: "Solid lines", on: true },
  { key: "junction", label: "Junction", on: false },
];
const MAPS = [
  { key: "heat_vehicles", label: "Vehicles", caption: "Where vehicles are over the whole video (log scale). Bright spots are where they stand: queues behind the stop line, bus stops, parking." },
  { key: "heat_people", label: "People", caption: "Where people walk over the whole video. Crossings stand out, and so do the paths people take beside them." },
  { key: "trajectories", label: "Trajectories", caption: "Every vehicle's path, coloured by its direction of travel." },
];
const GROUPS = [["samples", "Sample videos"], ["public", "Public footage"], ["upload", "Your video"]];
// failure cases on the samples, each with the moment to watch
const FAILURES = [
  { id: "C3902", t: 65, title: "A lane change across a solid line is missed.",
    text: "Solid and dashed are read from the paint. Here the solid part we find ends just short of where the car crosses, so the crossing counts as over the dashes. Four of the five in this video are found." },
  { id: "C3905", t: 43, title: "A lane change that ends at the stop line is missed.",
    text: "The car is still between lanes when it reaches the stop line, where the solid line ends. A lane change counts once the car has settled in the new lane, so this one is not reported; loosening that test added a false event elsewhere." },
  { id: "C3902", t: 304.5, title: "People who have just left the crossing can still count as on it.",
    text: "They step back onto the kerb as the car turns, but for a moment their feet are still inside the crossing's outline, so it is reported as failing to yield." },
  { id: "C3902", t: 63, title: "One long jaywalk is split into three events.",
    text: "A man walks beside the crossing for two minutes. Twice he stops right at its edge, where it is borderline whether he is off it, and the event is split there." },
  { id: "r09_s05__s040_camera_basler_north_50mm", t: 66, title: "A false accident inside thick smoke.",
    text: "On a motorway fire from a public dataset, cars disappearing into the smoke look like a collision for two seconds." },
];

const pretty = c => c.replace(/_/g, " ");
const clock = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const NS = "http://www.w3.org/2000/svg";
const $ = (s, root = document) => root.querySelector(s);
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function el(tag, attrs = {}, parent) {
  const svg = ["svg", "g", "rect", "line", "path", "polyline", "polygon", "text", "circle", "title"].includes(tag);
  const e = svg ? document.createElementNS(NS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  if (parent) parent.appendChild(e);
  return e;
}

const cache = {};
function json(url) {
  if (!(url in cache)) cache[url] = fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
  return cache[url];
}
function image(url) {
  if (!(url in cache)) cache[url] = new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; });
  return cache[url];
}

/* ---------------- clip data ---------------- */

function decodeTracks(doc) {
  // [id, class, frame deltas, box deltas] -> {id, cls, f: Int32Array, b: Float32Array (x1 y1 x2 y2 per sample)}
  return doc.tracks.map(([id, cls, df, db]) => {
    const f = new Int32Array(df.length), b = new Float32Array(db.length);
    let acc = 0;
    for (let i = 0; i < df.length; i++) { acc += df[i]; f[i] = acc; }
    for (let k = 0; k < 4; k++) { let a = 0; for (let i = k; i < db.length; i += 4) { a += db[i]; b[i] = a; } }
    return { id, cls, f, b, f0: f[0], f1: f[f.length - 1] };
  });
}

function boxAt(tr, frame, maxGap = 15) {
  const f = tr.f;
  let lo = 0, hi = f.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (f[m] <= frame) lo = m; else hi = m - 1; }
  const i = lo, j = Math.min(lo + 1, f.length - 1);
  if (f[i] === frame || i === j) return f[i] === frame ? tr.b.subarray(i * 4, i * 4 + 4) : null;
  if (f[j] - f[i] > maxGap) return null;
  const a = (frame - f[i]) / (f[j] - f[i]), out = new Float32Array(4);
  for (let k = 0; k < 4; k++) out[k] = tr.b[i * 4 + k] * (1 - a) + tr.b[j * 4 + k] * a;
  return out;
}

/* ---------------- explorer ---------------- */

const X = { clip: null, base: "", tracks: null, layers: {}, img: {}, on: Object.fromEntries(LAYERS.map(l => [l.key, l.on])), tabs: {} };

function layerToggles() {
  const host = $("#layers");
  for (const l of LAYERS) {
    const b = el("button", { class: "chip", "aria-pressed": String(l.on), text: l.label }, host);
    b.addEventListener("click", () => {
      X.on[l.key] = !X.on[l.key];
      b.setAttribute("aria-pressed", String(X.on[l.key]));
      draw();
    });
  }
}

async function openClip(entry, at) {
  const player = $("#video");
  X.clip = null; X.tracks = null; X.entry = entry;
  for (const [g, t] of Object.entries(X.tabs)) t.select(g === entry.group ? entry.id : null);
  const base = entry.base || "";
  const doc = await json(`${base}data/clips/${entry.id}.json`);
  if (!doc || X.entry !== entry) return;
  X.clip = doc; X.base = base;
  X.involved = {};
  for (const [tid, a, b, lab] of doc.involved || []) (X.involved[tid] ||= []).push([a, b, lab]);
  const src = `${base}media/${entry.id}.mp4`;
  if (player.getAttribute("src") !== src) { player.src = src; player.poster = `${base}data/clips/${entry.id}_plate.jpg`; }
  const m = doc.meta;
  $("#clip-info").textContent = [`${m.width}×${m.height}`, `${m.fps} fps`, clock(m.duration), doc.light, doc.caption]
    .filter(Boolean).join(" · ");
  const dl = $("#download");
  dl.hidden = !!entry.base;
  dl.href = `media/annotated/${entry.id}.mp4`;
  timeline($("#timeline"), doc, player).seek(at);
  countsChart();
  showMap();
  json(`${base}data/clips/${entry.id}.tracks.json`).then(t => { if (X.clip === doc && t) { X.tracks = decodeTracks(t); draw(); } });
  draw();
}

/* ---------------- motion maps: static, over the clean background ---------------- */

let mapKey = "heat_vehicles";
async function showMap() {
  const doc = X.clip, entry = X.entry;
  if (!doc) return;
  const c = $("#map"), g = c.getContext("2d");
  const [plate, layer] = await Promise.all([image(`${X.base}data/clips/${entry.id}_plate.jpg`), image(`${X.base}data/clips/${entry.id}_${mapKey}.png`)]);
  if (X.clip !== doc || !plate) return;
  c.width = plate.width; c.height = plate.height;
  g.globalAlpha = 1; g.drawImage(plate, 0, 0);
  g.fillStyle = "rgba(0,0,0,.45)"; g.fillRect(0, 0, c.width, c.height);
  if (layer) g.drawImage(layer, 0, 0, c.width, c.height);
  $("#map-caption").textContent = MAPS.find(m => m.key === mapKey).caption;
}
function mapTabs() {
  const bar = $("#map-tabs");
  const btns = MAPS.map(m => el("button", { role: "tab", text: m.label, "aria-selected": String(m.key === mapKey), onclick: () => {
    mapKey = m.key; btns.forEach((b, i) => b.setAttribute("aria-selected", String(MAPS[i].key === mapKey))); showMap();
  } }, bar));
}

function fitCanvas() {
  const v = $("#video"), c = $("#overlay");
  const r = v.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  // the picture inside the element (letterboxed to its aspect ratio), leaving room for the native controls
  const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
  const scale = Math.min(r.width / vw, r.height / vh);
  const w = vw * scale, h = vh * scale;
  c.style.width = `${w}px`; c.style.height = `${h}px`;
  c.style.left = `${(r.width - w) / 2}px`; c.style.top = `${(r.height - h) / 2}px`;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  return { c, w: c.width, h: c.height, dpr };
}

function draw() {
  const doc = X.clip;
  const { c, w, h, dpr } = fitCanvas();
  const g = c.getContext("2d");
  g.clearRect(0, 0, w, h);
  const chips = $("#active");
  chips.innerHTML = "";
  if (!doc) return;
  const v = $("#video"), t = v.currentTime || 0;
  const [FW, FH] = doc.frame || [1920, 1080];
  const sx = w / FW, sy = h / FH;
  const sc = doc.scene || {};
  const path = pts => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x * sx, y * sy) : g.moveTo(x * sx, y * sy))); };
  g.lineJoin = "round"; g.lineCap = "round";
  if (X.on.junction) {
    g.setLineDash([8 * dpr, 6 * dpr]); g.strokeStyle = "rgba(255,255,255,.85)"; g.lineWidth = 1.5 * dpr;
    for (const p of sc.junction || []) { path(p); g.closePath(); g.stroke(); }
    g.setLineDash([]);
  }
  if (X.on.crossings) {
    g.fillStyle = "rgba(120,200,230,.28)"; g.strokeStyle = "rgba(120,200,230,.9)"; g.lineWidth = 1.2 * dpr;
    for (const p of Object.values(sc.crosswalks || {})) { path(p); g.closePath(); g.fill(); g.stroke(); }
  }
  if (X.on.stopline) for (const a of sc.approaches || []) {
    g.fillStyle = "rgba(255,95,85,.10)";
    for (const p of a.zone || []) { path(p); g.closePath(); g.fill(); }
    g.strokeStyle = "rgb(255,95,85)"; g.lineWidth = 3 * dpr; path(a.stop_line); g.stroke();
  }
  if (X.on.lines) for (const [x1, y1, x2, y2, kind] of sc.lines || []) {
    if (kind !== "solid") continue;
    g.strokeStyle = "rgb(250,190,60)"; g.lineWidth = 2.5 * dpr;
    g.beginPath(); g.moveTo(x1 * sx, y1 * sy); g.lineTo(x2 * sx, y2 * sy); g.stroke();
  }
  if (X.on.boxes && X.tracks) {
    const frame = Math.round(t * doc.meta.fps);
    g.font = `${11 * dpr}px IBM Plex Mono, monospace`;
    for (const tr of X.tracks) {
      if (frame < tr.f0 || frame > tr.f1) continue;
      const b = boxAt(tr, frame);
      if (!b) continue;
      const hits = X.on.events ? (X.involved[tr.id] || []).filter(([a, e]) => a <= t && t <= e) : [];
      const x = b[0] * sx, y = b[1] * sy, bw = (b[2] - b[0]) * sx, bh = (b[3] - b[1]) * sy;
      if (hits.length) {
        const col = CLASS_COLOUR[hits[0][2]] || "#fff";
        g.strokeStyle = col; g.lineWidth = 2 * dpr; g.strokeRect(x, y, bw, bh);
        if (!(hits[0][2] === "failure_to_yield" && tr.cls === PERSON)) {   // the label goes on who breaks the rule
          const label = pretty(hits[0][2]), tw = g.measureText(label).width + 8 * dpr;
          g.fillStyle = col; g.fillRect(x, y - 16 * dpr, tw, 15 * dpr);
          g.fillStyle = "#111"; g.fillText(label, x + 4 * dpr, y - 5 * dpr);
        }
      } else {
        g.strokeStyle = tr.cls === PERSON ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.75)";
        g.lineWidth = 1 * dpr; g.strokeRect(x, y, bw, bh);
      }
    }
  }
  if (X.on.events) for (const [t0, t1, lab, x1, y1, x2, y2] of doc.regions || []) {   // fire, smoke, obstacles
    if (t < t0 || t > t1) continue;
    const col = CLASS_COLOUR[lab] || "#fff";
    g.strokeStyle = col; g.lineWidth = 2 * dpr; g.strokeRect(x1 * sx, y1 * sy, (x2 - x1) * sx, (y2 - y1) * sy);
    g.font = `${11 * dpr}px IBM Plex Mono, monospace`;
    const label = pretty(lab), tw = g.measureText(label).width + 8 * dpr;
    g.fillStyle = col; g.fillRect(x1 * sx, y1 * sy - 16 * dpr, tw, 15 * dpr);
    g.fillStyle = "#111"; g.fillText(label, x1 * sx + 4 * dpr, y1 * sy - 5 * dpr);
  }
  if (X.on.events) for (const [s, e, lab] of doc.events) {
    if (s <= t && t <= e) el("span", { text: pretty(lab), style: `background:${CLASS_COLOUR[lab] || "#ddd"}` }, chips);
  }
  if (X.on.signal && doc.signal && doc.signal.vehicle) {
    const st = (doc.signal.vehicle.find(([a, b]) => a <= t && t < b) || [])[2];
    if (st) el("span", { class: `sig ${st}`, text: `signal: ${st}` }, chips);
  }
  if (countsHead) { const x = countsHead.x(t); countsHead.line.setAttribute("x1", x); countsHead.line.setAttribute("x2", x); }
}

function explorerLoop() {
  const v = $("#video");
  const toggleFull = () => {                    // the stage (video + overlay) goes full screen, so labels stay
    const st = $("#stage");
    if (document.fullscreenElement) document.exitFullscreen(); else (st.requestFullscreen || st.webkitRequestFullscreen).call(st);
  };
  $("#fullscreen").addEventListener("click", toggleFull);
  v.addEventListener("dblclick", ev => { ev.preventDefault(); toggleFull(); });
  document.addEventListener("keydown", ev => {
    if (ev.key === "f" && !/input|textarea/i.test(ev.target.tagName) && $("#stage").getBoundingClientRect().top < innerHeight) toggleFull();
  });
  // the browser's own full-screen button (where it cannot be hidden) takes only the bare video, without the
  // labels: hand full screen over to the stage instead
  const toStage = () => {
    if (document.fullscreenElement === v) document.exitFullscreen().then(toggleFull).catch(() => {});
  };
  document.addEventListener("fullscreenchange", () => { toStage(); requestAnimationFrame(draw); });
  v.addEventListener("webkitbeginfullscreen", () => { v.webkitExitFullscreen && v.webkitExitFullscreen(); toggleFull(); });
  let raf = 0;
  const loop = () => { draw(); raf = v.paused ? 0 : requestAnimationFrame(loop); };
  v.addEventListener("play", () => { if (!raf) raf = requestAnimationFrame(loop); });
  v.addEventListener("seeked", draw);
  v.addEventListener("loadedmetadata", draw);
  new ResizeObserver(draw).observe($("#stage"));
}

/* ---------------- timeline: one row per class, then the risk curve; click to seek ---------------- */

function timeline(host, doc, player) {
  const ROW = 22, RISK = 56, AXIS = 18;
  const duration = doc.meta.duration;
  const classes = CLASSES.filter(c => doc.events.some(e => e[2] === c));
  const hasRisk = doc.risk && doc.risk.length;
  host.innerHTML = "";
  const names = el("div", {}, host);
  const track = el("div", { class: "track" }, host);
  classes.forEach(c => el("div", { class: "name", html: `<i style="background:${CLASS_COLOUR[c]}"></i>${pretty(c)}`, title: pretty(c) }, names));
  if (hasRisk) el("div", { class: "name risk", html: "risk<br><span style='color:var(--muted)'>alarm at 0.5</span>" }, names);
  if (!classes.length && !hasRisk) { names.textContent = "No events."; return { seek() {} }; }

  let head, W = 0;
  function render() {
    W = track.clientWidth;
    if (!W) return;
    const H = classes.length * ROW + (hasRisk ? RISK : 0) + AXIS;
    track.innerHTML = "";
    const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, track);
    const x = t => (t / duration) * W;
    classes.forEach((c, i) => {
      const y = i * ROW;
      el("line", { x1: 0, x2: W, y1: y + ROW - 0.5, y2: y + ROW - 0.5, stroke: css("--rule") }, svg);
      for (const [s, e, lab] of doc.events) {
        if (lab !== c) continue;
        const r = el("rect", {
          class: "ev", x: x(s), y: y + 3, width: Math.max(2, x(e) - x(s)), height: 14, rx: 1,
          fill: css("--ink"), onclick: ev => { ev.stopPropagation(); seek(s); },
        }, svg);
        el("title", { text: `${pretty(lab)} ${clock(s)}–${clock(e)}` }, r);
      }
    });
    let y0 = classes.length * ROW;
    if (hasRisk) {
      const ry = v => y0 + RISK - 6 - v * (RISK - 12);
      el("line", { x1: 0, x2: W, y1: ry(0.5), y2: ry(0.5), stroke: css("--muted"), "stroke-dasharray": "2 3" }, svg);
      const step = Math.max(1, Math.floor(doc.risk.length / (W * 1.5)));
      const pts = [];
      for (let i = 0; i < doc.risk.length; i += step) {
        let v = 0;
        for (let j = i; j < Math.min(i + step, doc.risk.length); j++) v = Math.max(v, doc.risk[j][1]);
        pts.push(`${x(doc.risk[i][0]).toFixed(1)},${ry(v).toFixed(1)}`);
      }
      el("polyline", { points: pts.join(" "), fill: "none", stroke: css("--ink"), "stroke-width": 1.2 }, svg);
      el("line", { x1: 0, x2: W, y1: y0 + RISK - 0.5, y2: y0 + RISK - 0.5, stroke: css("--rule") }, svg);
      y0 += RISK;
    }
    const axis = el("g", { class: "axis" }, svg);
    const every = duration > 240 ? 60 : duration > 90 ? 30 : 10;
    for (let t = 0; t <= duration; t += every) {
      if (x(t) > W - 34 && t > 0) break;
      el("line", { x1: x(t), x2: x(t), y1: y0, y2: y0 + 4, stroke: css("--muted") }, axis);
      el("text", { x: x(t) + 3, y: y0 + 14, text: clock(t) }, axis);
    }
    head = el("line", { x1: 0, x2: 0, y1: 0, y2: y0, stroke: css("--accent"), "stroke-width": 1 }, svg);
    svg.addEventListener("click", ev => seek((ev.offsetX / W) * duration));
    svg.style.cursor = "pointer";
    tick();
  }
  function seek(t) {
    if (!player || t === undefined) return;
    const go = () => { player.currentTime = Math.max(0, t - 1); player.play().catch(() => {}); };
    if (player.readyState >= 1) go(); else player.addEventListener("loadedmetadata", go, { once: true });
  }
  function tick() {
    if (head && player && W) { const px = (player.currentTime / duration) * W; head.setAttribute("x1", px); head.setAttribute("x2", px); }
  }
  if (player) {
    if (player._timeline) player._timeline.abort();
    player._timeline = new AbortController();
    const signal = player._timeline.signal;
    player.addEventListener("timeupdate", tick, { signal });
    player.addEventListener("seeked", tick, { signal });
  }
  if (host._resize) host._resize.disconnect();
  host._resize = new ResizeObserver(() => { if (track.clientWidth !== W) render(); });
  host._resize.observe(track);
  render();
  return { seek };
}

/* ---------------- road users over time ---------------- */

let countsHead = null;
function countsChart() {
  const host = $("#counts-chart"), d = X.clip;
  host.innerHTML = "";
  countsHead = null;
  if (!d || !d.counts) return;
  const W = host.clientWidth || 800, H = 200, top = 8, L = 30;
  const svg = el("svg", { width: W, height: H + top + 24, viewBox: `0 0 ${W} ${H + top + 24}` }, host);
  const dur = d.meta.duration;
  const x = t => (t / dur) * (W - L) + L;
  const ymax = Math.ceil(Math.max(...COUNT_CLASSES.flatMap(([k]) => d.counts[k] || [0]), 1) / 10) * 10;
  const y = v => top + H - (v / ymax) * H;
  if (d.signal && d.signal.vehicle) for (const [s, e, st] of d.signal.vehicle) {
    if (st === "red") el("rect", { x: x(s), y: top, width: Math.max(0, x(e) - x(s)), height: H, fill: css("--accent-soft") }, svg);
  }
  const grid = el("g", { class: "grid" }, svg);
  for (let v = 0; v <= ymax; v += ymax / 4) {
    el("line", { x1: L, x2: W, y1: y(v), y2: y(v) }, grid);
    el("text", { x: 0, y: y(v) + 3, text: v }, svg);
  }
  const shades = [css("--ink"), css("--accent"), css("--muted"), css("--ink-2"), css("--muted"), css("--ink-2")];
  const dashes = ["", "", "", "4 3", "1 3", "1 3"];
  const lg = $("#counts-legend");
  lg.innerHTML = "";
  COUNT_CLASSES.forEach(([k, name], i) => {
    if (!d.counts[k]) return;
    const pts = d.counts[k].map((v, j) => `${x(j + 0.5).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    el("polyline", { points: pts, fill: "none", stroke: shades[i], "stroke-width": i < 2 ? 1.5 : 1.1, "stroke-dasharray": dashes[i] }, svg);
    el("span", { html: `<i style="height:2px;background:${shades[i]}"></i>${name}` }, lg);
  });
  if (d.signal && d.signal.vehicle) el("span", { html: `<i style="background:${css("--accent-soft")}"></i>red light` }, lg);
  const every = dur > 240 ? 60 : dur > 90 ? 30 : 10;
  for (let t = 0; t <= dur; t += every) if (x(t) < W - 30) el("text", { x: x(t) - 8, y: top + H + 16, text: clock(t) }, svg);
  const line = el("line", { x1: L, x2: L, y1: top, y2: top + H, stroke: css("--accent") }, svg);
  countsHead = { x, line };
  svg.style.cursor = "pointer";
  svg.addEventListener("click", ev => {
    const t = Math.max(0, ((ev.offsetX - L) / (W - L)) * dur);
    const v = $("#video");
    v.currentTime = t; v.play().catch(() => {});
  });
}

/* ---------------- clip picker ---------------- */

async function clipPicker() {
  const index = (await json("data/clips/index.json")) || [];
  X.index = index;
  const host = $("#clip-groups");
  host.innerHTML = "";
  for (const [g, title] of GROUPS) {
    const wrap = el("div", { "data-group": g }, host);
    el("small", { text: title }, wrap);
    const bar = el("div", { class: "tabs", role: "tablist" }, wrap);
    const items = index.filter(c => c.group === g);
    wrap.hidden = !items.length;
    X.tabs[g] = {
      bar, wrap,
      add(entry) {
        el("button", { role: "tab", text: entry.title, "aria-selected": "false", "data-id": entry.id, onclick: () => openClip(entry) }, bar);
        wrap.hidden = false;
      },
      select(id) { bar.querySelectorAll("button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.id === id))); },
    };
    items.forEach(e => X.tabs[g].add(e));
  }
  if (index.length) openClip(index[0]);
}

function openById(id, at) {
  const entry = (X.index || []).find(c => c.id === id);
  if (!entry) return;
  openClip(entry, at);
  const y = $("#clip-groups").getBoundingClientRect().top + scrollY - 70;     // the video, under the sticky header
  scrollTo({ top: y, behavior: "smooth" });
}

/* ---------------- results ---------------- */

async function results() {
  const summary = await json("data/summary.json");
  const samples = (X.index || []).filter(c => c.group === "samples");
  const docs = (await Promise.all(samples.map(c => json(`data/clips/${c.id}.json`)))).filter(Boolean);
  const body = $("#class-table tbody");
  body.innerHTML = "";
  if (summary) {
    for (const c of CLASSES) {
      if (summary.per_class[c] === undefined) continue;
      const n = docs.reduce((a, d) => a + d.events.filter(e => e[2] === c).length, 0);
      el("tr", { html: `<td>${pretty(c)}</td><td class="n">${n}</td><td class="n">${summary.per_class[c].toFixed(2)}</td>` }, body);
    }
    el("tr", { class: "sub", html: `<td>Score (mean over classes)</td><td></td><td class="n">${summary.score_a.toFixed(2)}</td>` }, body);
  }
  const ex = $("#examples");
  ex.innerHTML = "";
  const rank = e => (e[1] - e[0] < 60 ? e[1] - e[0] : -(e[1] - e[0]));
  for (const c of CLASSES) {
    let best = null;
    for (const d of docs) for (const e of d.events) if (e[2] === c && e[3] && (!best || rank(e) > rank(best.e))) best = { id: d.id, e };
    if (!best) continue;
    el("button", { html: `<b><i style="background:${CLASS_COLOUR[c]}"></i>${pretty(c)}</b><small>${best.id} · ${clock(best.e[0])}</small>`, onclick: () => openById(best.id, best.e[0]) }, ex);
  }
  const fl = $("#failures");
  fl.innerHTML = "";
  for (const f of FAILURES) {
    const li = el("li", {}, fl), div = el("div", {}, li);
    el("b", { text: f.title }, div);
    el("p", { text: f.text }, div);
    const name = ((X.index || []).find(c => c.id === f.id) || {}).title || f.id;
    el("button", { class: "watch", text: `▶ Watch ${name} at ${clock(f.t)}`, onclick: () => openById(f.id, f.t + 1) }, div);
  }
  const rows = await json("data/public.json");
  const pb = $("#public-table tbody");
  pb.innerHTML = "";
  for (const r of rows || []) el("tr", { html: `<td>${r.name}</td><td class="n">${r.clips}</td><td>${r.result}</td>` }, pb);
  const eb = $("#eda-table tbody");
  eb.innerHTML = "";
  const mean = a => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(1);
  const others = (X.index || []).filter(c => c.group === "public");
  const otherDocs = (await Promise.all(others.map(c => json(`data/clips/${c.id}.json`)))).filter(Boolean);
  const row = (name, d) => {
    const m = d.meta;
    el("tr", { html: `<td>${name}</td><td>${d.light || ""}</td><td class="n">${m.width}×${m.height}</td><td class="n">${m.fps}</td>
      <td class="n">${clock(m.duration)}</td><td class="n">${mean(d.counts.car)}</td><td class="n">${mean(d.counts.person)}</td>` }, eb);
  };
  for (const d of docs) row(d.id, d);
  if (otherDocs.length) el("tr", { class: "group", html: `<td colspan="7">Other cameras: TUMTraf Accid3nD</td>` }, eb);
  otherDocs.forEach((d, i) => row(others.find(c => c.id === d.id)?.title || others[i].title, d));
}

/* ---------------- demo ---------------- */

function demo() {
  const drop = $("#drop"), input = $("#file"), panel = $("#run"), bar = $("#bar"), status = $("#status");
  const cancelBtn = $("#cancel"), note = $("#demo-note");
  const say = (msg, frac) => { status.textContent = msg; if (frac !== undefined) bar.style.width = `${Math.round(frac * 100)}%`; };
  const mb = b => (b / 1e6).toFixed(b < 1e8 ? 1 : 0);
  const eta = s => (s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`);
  const JSON_HDR = { "Content-Type": "application/json" };
  let cur = null;   // the run in progress: { upload, job, xhrs, cancelled }

  // the drop box and the progress panel take turns: one run at a time
  const showPanel = title => {
    $("#run-name").textContent = title;
    cancelBtn.textContent = "Cancel";
    drop.hidden = note.hidden = true; panel.hidden = false;
  };
  const showDrop = () => { panel.hidden = true; drop.hidden = note.hidden = false; input.value = ""; };

  if (!DEMO_API) { drop.hidden = true; note.textContent = "The demo server is not connected yet."; }
  ["dragover", "dragenter"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove("over")));
  drop.addEventListener("drop", e => { e.preventDefault(); if (e.dataTransfer.files[0]) run(e.dataTransfer.files[0]); });
  input.addEventListener("change", () => input.files[0] && run(input.files[0]));
  $("#try-sample").addEventListener("click", e => { e.preventDefault(); run(null); });
  cancelBtn.addEventListener("click", () => {
    if (!cur) return showDrop();                      // after a finished run the button reads "Upload another"
    cur.cancelled = true;
    cur.xhrs.forEach(x => x.abort());
    fetch(`${DEMO_API}/cancel`, { method: "POST", headers: JSON_HDR, body: JSON.stringify({ upload: cur.upload, job: cur.job }) })
      .catch(() => {});
    cur = null;
    showDrop();
  });

  async function post(path, body, headers = {}) {
    const res = await fetch(`${DEMO_API}${path}`, { method: "POST", body, headers });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.detail || `error ${res.status}`);
    return out;
  }
  // one chunk, with byte-level progress (fetch cannot report upload progress)
  function sendChunk(run, off, blob, onBytes) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      run.xhrs.add(xhr);
      xhr.open("POST", `${DEMO_API}/uploads/${run.upload}?offset=${off}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = e => onBytes(e.loaded);
      xhr.onload = () => { run.xhrs.delete(xhr); xhr.status < 300 ? resolve() : reject(new Error(`error ${xhr.status}`)); };
      xhr.onerror = xhr.onabort = () => { run.xhrs.delete(xhr); reject(new Error("the connection dropped")); };
      xhr.send(blob);
    });
  }
  const progress = (run, done, total, t0) => {
    if (run.cancelled) return;
    const rate = done / Math.max((performance.now() - t0) / 1000, 0.5);
    const left = rate > 0 && done < total ? ` · about ${eta((total - done) / rate)} left` : "";
    say(`Uploading ${Math.round(100 * done / total)}% · ${mb(done)} of ${mb(total)} MB · ${(rate / 1e6).toFixed(1)} MB/s${left}`,
      0.02 + 0.28 * done / total);
  };
  // fast path: the browser sends the whole file straight to Google Drive, to an upload the server opened
  async function viaDrive(run, file) {
    const d = await post("/uploads/drive", JSON.stringify({ name: file.name, size: file.size, origin: location.origin }), JSON_HDR);
    run.upload = d.id;
    const t0 = performance.now();
    const body = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      run.xhrs.add(xhr);
      xhr.open("PUT", d.url);
      xhr.upload.onprogress = e => progress(run, e.loaded, file.size, t0);
      xhr.onload = () => { run.xhrs.delete(xhr); xhr.status < 300 ? resolve(xhr.responseText) : reject(new Error(`error ${xhr.status}`)); };
      xhr.onerror = xhr.onabort = () => { run.xhrs.delete(xhr); reject(new Error("the connection dropped")); };
      xhr.send(file);
    });
    run.driveFile = JSON.parse(body).id;
  }
  // fallback: chunks to the demo server itself
  async function upload(run, file) {
    const offsets = [];
    for (let off = 0; off < file.size; off += CHUNK) offsets.push(off);
    const sent = new Map(), t0 = performance.now();
    const show = () => progress(run, [...sent.values()].reduce((a, b) => a + b, 0), file.size, t0);
    const timer = setInterval(show, 500);
    try {
      const worker = async () => {
        for (let off; (off = offsets.shift()) !== undefined;) {
          for (let attempt = 1; ; attempt++) {
            if (run.cancelled) return;
            try {
              await sendChunk(run, off, file.slice(off, off + CHUNK), n => sent.set(off, n));
              sent.set(off, Math.min(CHUNK, file.size - off));
              break;
            } catch (err) {
              sent.set(off, 0);
              if (attempt === 3 || run.cancelled) throw err;
            }
          }
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
    } finally { clearInterval(timer); }
    show();
  }

  async function run(file) {
    if (cur || !DEMO_API) return;
    if (file && file.size > 4e9) { note.hidden = false; note.textContent = "That file is over 4 GB."; return; }
    const me = cur = { upload: null, driveFile: null, job: null, xhrs: new Set(), cancelled: false };
    const title = file ? `${file.name} · ${mb(file.size)} MB` : "Sample video";
    showPanel(title);
    say("Connecting to the server… after a quiet spell it takes up to a minute to start.", 0.02);
    const finish = msg => { if (me.cancelled) return; cur = null; say(msg); cancelBtn.textContent = "Upload another"; };
    try {
      if (file) {
        try {
          await viaDrive(me, file);
        } catch (err) {
          if (me.cancelled) return;
          if (me.upload) post("/cancel", JSON.stringify({ upload: me.upload }), JSON_HDR).catch(() => {});
          me.upload = me.driveFile = null;
          say("Uploading to the demo server directly…", 0.02);
          me.upload = (await post("/uploads", JSON.stringify({ name: file.name, size: file.size }), JSON_HDR)).id;
          if (me.cancelled) return;
          await upload(me, file);
        }
        if (me.cancelled) return;
        say("Upload complete. Starting the analysis…", 0.3);
        const spec = me.driveFile ? { upload: me.upload, drive_file: me.driveFile } : { upload: me.upload };
        me.job = (await post("/jobs", JSON.stringify(spec), JSON_HDR)).id;
      } else {
        me.job = (await post("/jobs", JSON.stringify({ sample: "C3902_0-140s" }), JSON_HDR)).id;
      }
    } catch (err) { return finish(`Not accepted: ${err.message}.`); }
    for (;;) {
      await new Promise(r => setTimeout(r, 1500));
      if (me.cancelled) return;
      let st, res;
      try { res = await fetch(`${DEMO_API}/jobs/${me.job}`); st = await res.json(); } catch (err) { continue; }
      if (me.cancelled) return;
      if (res.status === 404) return finish("The server restarted during the run, so this job was lost. Please try again.");
      if (st.state === "error") return finish(`The run failed: ${st.message || "unknown error"}.`);
      if (st.state === "cancelled") return finish("Cancelled.");
      if (st.state !== "done") { say(`${st.stage || "Queued"}…`, 0.3 + 0.7 * (st.progress || 0)); continue; }
      const n = st.result.events;
      finish(`Done: ${n} event${n === 1 ? "" : "s"}${st.result.trimmed ? " in the first 3 minutes" : ""}. Opened in the explorer above.`);
      bar.style.width = "100%";
      const entry = { id: st.result.clip, title: file ? file.name.slice(0, 28) : "Sample video", group: "upload",
        base: `${DEMO_API}/jobs/${me.job}/site/` };
      X.index.push(entry);
      X.tabs.upload.add(entry);
      openClip(entry);
      $("#explorer").scrollIntoView();
      return;
    }
  }
}

/* ---------------- page ---------------- */

function nav() {
  const links = [...document.querySelectorAll(".nav a.l[href^='#']")];
  const byId = Object.fromEntries(links.map(a => [a.getAttribute("href").slice(1), a]));
  const io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) {
      links.forEach(a => a.classList.remove("on"));
      byId[e.target.id] && byId[e.target.id].classList.add("on");
    }
  }, { rootMargin: "-45% 0px -50% 0px" });
  Object.keys(byId).forEach(id => { const s = document.getElementById(id); s && io.observe(s); });
}

function theme() {
  const btn = $("#theme"), root = document.documentElement;
  const dark = () => (root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
  try { const t = localStorage.getItem("theme"); if (t) root.dataset.theme = t; } catch (err) { /* private mode */ }
  const SUN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>';
  const MOON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7z"/></svg>';
  const label = () => { btn.innerHTML = dark() ? SUN : MOON; btn.title = dark() ? "Light mode" : "Dark mode"; };
  btn.addEventListener("click", () => {
    root.dataset.theme = dark() ? "light" : "dark";
    try { localStorage.setItem("theme", root.dataset.theme); } catch (err) { /* ignore */ }
    label();
    if (X.clip) { timeline($("#timeline"), X.clip, $("#video")); countsChart(); }
  });
  label();
}

async function main() {
  theme(); nav(); layerToggles(); mapTabs(); explorerLoop(); demo();
  await clipPicker();
  results();
  let w = innerWidth;
  addEventListener("resize", () => { if (innerWidth !== w) { w = innerWidth; countsChart(); } });
}
main();
