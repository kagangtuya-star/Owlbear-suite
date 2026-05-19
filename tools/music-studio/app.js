/* Music Studio main controller.
 *
 * Flow:
 *   source ──┬─ local file → WebAudio.decode → waveform → trim handles
 *            │                 → encode (ffmpeg.wasm → OPUS) → save to IDB
 *            └─ URL paste → save url-only entry to IDB
 *   library  → render grid → play / delete / export share-code
 */

import { encodeOpus, estimateOpusBytes } from "./encoder.js";
import { addTrack, deleteTrack, listTracks, getTrack } from "./library.js";
import { encodeShareCode } from "./share.js";

// ============ DOM refs ============
const $ = (s) => document.querySelector(s);

const sourceSeg     = $("#sourceSeg");
const srcFilePane   = $("#srcFilePane");
const srcUrlPane    = $("#srcUrlPane");
const fileDrop      = $("#fileDrop");
const fileInput     = $("#fileInput");
const urlInput      = $("#urlInput");
const urlAddBtn     = $("#urlAddBtn");

const editPanel     = $("#editPanel");
const trackName     = $("#trackName");
const trackMeta     = $("#trackMeta");
const waveformCanvas = $("#waveform");
const trimOverlay   = $("#trimOverlay");
const trimMaskL     = $("#trimMaskL");
const trimMaskR     = $("#trimMaskR");
const trimHandleL   = $("#trimHandleL");
const trimHandleR   = $("#trimHandleR");
const playCursor    = $("#playCursor");
const trimStartTxt  = $("#trimStartTxt");
const trimEndTxt    = $("#trimEndTxt");
const trimLenTxt    = $("#trimLenTxt");
const resetTrimBtn  = $("#resetTrimBtn");

const bitrateSeg    = $("#bitrateSeg");
const channelSeg    = $("#channelSeg");
const busSeg        = $("#busSeg");
const loopChk       = $("#loopChk");

const sizeEstimate  = $("#sizeEstimate");
const originalSize  = $("#originalSize");
const previewBtn    = $("#previewBtn");
const encodeBtn     = $("#encodeBtn");
const cancelEditBtn = $("#cancelEditBtn");
const encodeProg    = $("#encodeProg");
const encodeFill    = $("#encodeFill");
const encodeMsg     = $("#encodeMsg");

const libSearch     = $("#libSearch");
const libFilterSeg  = $("#libFilterSeg");
const libGrid       = $("#libGrid");
const exportAllBtn  = $("#exportAllBtn");

const shareModal    = $("#shareModal");
const shareTitle    = $("#shareTitle");
const shareCode     = $("#shareCode");
const shareMeta     = $("#shareMeta");
const copyShareBtn  = $("#copyShareBtn");

const toastStack    = $("#toastStack");

// ============ State ============
const state = {
  // Editor:
  currentFile:  null,        // File | null
  audioBuffer:  null,        // AudioBuffer of full decoded source
  trim:         { start: 0, end: 0 }, // seconds within audioBuffer
  bitrate:      64,
  channels:     1,
  bus:          "bgm",
  // Preview:
  preview:      null,        // currently-playing AudioBufferSourceNode
  // Library:
  libFilter:    "all",
  libSearchStr: "",
};

let audioCtx = null;
function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

// ============ Utilities ============
function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s - m * 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${pad2(m)}:${pad2(sec)}.${pad2(cs)}`;
}
function pad2(n) { return n < 10 ? "0" + n : "" + n; }
function fmtBytes(b) {
  if (!Number.isFinite(b) || b <= 0) return "--";
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / 1024 / 1024).toFixed(2) + " MB";
}
function parseTime(str) {
  // Accept "mm:ss.cs", "mm:ss", "ss.cs", "ss" — anything that becomes a
  // non-negative number. Returns null on garbage.
  if (typeof str !== "string") return null;
  const s = str.trim();
  if (!s) return null;
  const colon = s.indexOf(":");
  if (colon < 0) {
    const f = parseFloat(s);
    return Number.isFinite(f) && f >= 0 ? f : null;
  }
  const m = parseInt(s.slice(0, colon), 10);
  const rest = parseFloat(s.slice(colon + 1));
  if (!Number.isFinite(m) || !Number.isFinite(rest)) return null;
  return m * 60 + rest;
}

function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = text;
  toastStack.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s, transform .25s";
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    setTimeout(() => el.remove(), 260);
  }, 2400);
}

// ============ Source switching ============
sourceSeg.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-opt[data-src]");
  if (!btn) return;
  sourceSeg.querySelectorAll(".seg-opt").forEach((b) => b.classList.remove("on"));
  btn.classList.add("on");
  const mode = btn.dataset.src;
  srcFilePane.classList.toggle("hidden", mode !== "file");
  srcUrlPane.classList.toggle("hidden", mode !== "url");
});

// ============ Local file: drop + select ============
fileDrop.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
  fileInput.value = ""; // allow re-pick of the same file later
});
["dragenter", "dragover"].forEach((evt) =>
  fileDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    fileDrop.classList.add("drag-over");
  }),
);
["dragleave", "dragend", "drop"].forEach((evt) =>
  fileDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    fileDrop.classList.remove("drag-over");
  }),
);
fileDrop.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

async function loadFile(file) {
  state.currentFile = file;
  trackName.value = file.name.replace(/\.[a-z0-9]+$/i, "");
  trackMeta.textContent = "解码中…";
  editPanel.classList.remove("hidden");

  try {
    const ab = await file.arrayBuffer();
    // decodeAudioData mutates the input ArrayBuffer in some browsers
    // (transfers it). Pass a slice to be safe — we may re-read original
    // bytes later for encoding (ffmpeg path uses file.arrayBuffer()
    // directly so this is belt-and-braces).
    const buf = await getCtx().decodeAudioData(ab.slice(0));
    state.audioBuffer = buf;
    state.trim.start = 0;
    state.trim.end = buf.duration;

    trackMeta.textContent =
      `${fmtTime(buf.duration)} · ${buf.sampleRate}Hz · ` +
      `${buf.numberOfChannels === 2 ? "立体声" : (buf.numberOfChannels + "ch")} · ` +
      fmtBytes(file.size);
    originalSize.textContent = fmtBytes(file.size);

    renderWaveform();
    syncTrimUI();
    updateSizeEstimate();
  } catch (err) {
    console.error("decode failed", err);
    trackMeta.textContent = "";
    toast("解码失败 —— 文件可能损坏或浏览器不支持该编码", "error");
    state.currentFile = null;
    state.audioBuffer = null;
    editPanel.classList.add("hidden");
  }
}

// ============ Waveform rendering ============
let _waveDims = { w: 0, h: 0 };
function renderWaveform() {
  if (!state.audioBuffer) return;
  const cv = waveformCanvas;
  // Match canvas backing-store to its CSS size × devicePixelRatio so
  // peaks render crisp on hi-dpi (retina, 4K) without blowing CPU on
  // low-dpi.
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth, cssH = cv.clientHeight;
  cv.width  = Math.max(1, Math.floor(cssW * dpr));
  cv.height = Math.max(1, Math.floor(cssH * dpr));
  _waveDims = { w: cssW, h: cssH };

  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // Min/max envelope per pixel column → classic two-band waveform.
  // Mix all channels to mono for visualisation only (the encoded output
  // honours the user's mono/stereo pick separately).
  const buf = state.audioBuffer;
  const data0 = buf.getChannelData(0);
  const data1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const samplesPerPx = Math.max(1, Math.floor(data0.length / cssW));
  const midY = cssH / 2;
  const peakColor = getCssVar("--wave-peak");
  const rmsColor  = getCssVar("--wave-rms");

  // Peak band first (lighter).
  ctx.fillStyle = peakColor;
  for (let x = 0; x < cssW; x++) {
    const start = x * samplesPerPx;
    let lo = 0, hi = 0;
    const end = Math.min(data0.length, start + samplesPerPx);
    for (let i = start; i < end; i++) {
      let v = data0[i];
      if (data1) v = (v + data1[i]) * 0.5;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const y1 = midY - hi * midY;
    const y2 = midY - lo * midY;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }

  // RMS band on top (denser, brighter).
  ctx.fillStyle = rmsColor;
  for (let x = 0; x < cssW; x++) {
    const start = x * samplesPerPx;
    let sum = 0, cnt = 0;
    const end = Math.min(data0.length, start + samplesPerPx);
    for (let i = start; i < end; i++) {
      let v = data0[i];
      if (data1) v = (v + data1[i]) * 0.5;
      sum += v * v;
      cnt++;
    }
    const rms = cnt ? Math.sqrt(sum / cnt) : 0;
    const h = rms * midY * 1.6;
    ctx.fillRect(x, midY - h, 1, h * 2);
  }

  // Centre baseline.
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(0, midY - 0.5, cssW, 1);
}
function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#5dade2";
}

// Re-render waveform when the canvas resizes (responsive layout).
const ro = new ResizeObserver(() => renderWaveform());
ro.observe(waveformCanvas);

// ============ Trim handles (mouse + touch) ============
function syncTrimUI() {
  if (!state.audioBuffer) return;
  const dur = state.audioBuffer.duration;
  const pxPerSec = waveformCanvas.clientWidth / dur;

  const lx = state.trim.start * pxPerSec;
  const rx = state.trim.end   * pxPerSec;

  trimMaskL.style.width   = `${lx}px`;
  trimMaskR.style.width   = `${waveformCanvas.clientWidth - rx}px`;
  trimHandleL.style.left  = `${lx}px`;
  trimHandleR.style.left  = `${rx}px`;

  trimStartTxt.value = fmtTime(state.trim.start);
  trimEndTxt.value   = fmtTime(state.trim.end);
  trimLenTxt.textContent = fmtTime(state.trim.end - state.trim.start);
  updateSizeEstimate();
}

let _dragHandle = null;
function onHandleDown(handle, e) {
  _dragHandle = handle;
  e.preventDefault();
  document.body.style.userSelect = "none";
}
function onHandleMove(e) {
  if (!_dragHandle || !state.audioBuffer) return;
  const rect = waveformCanvas.getBoundingClientRect();
  const cx = (e.touches ? e.touches[0].clientX : e.clientX);
  const px = Math.max(0, Math.min(rect.width, cx - rect.left));
  const t  = (px / rect.width) * state.audioBuffer.duration;
  const minSpan = 0.1;
  if (_dragHandle === "L") {
    state.trim.start = Math.max(0, Math.min(t, state.trim.end - minSpan));
  } else {
    state.trim.end = Math.min(state.audioBuffer.duration, Math.max(t, state.trim.start + minSpan));
  }
  syncTrimUI();
}
function onHandleUp() {
  _dragHandle = null;
  document.body.style.userSelect = "";
}
trimHandleL.addEventListener("mousedown",  (e) => onHandleDown("L", e));
trimHandleR.addEventListener("mousedown",  (e) => onHandleDown("R", e));
trimHandleL.addEventListener("touchstart", (e) => onHandleDown("L", e), { passive: false });
trimHandleR.addEventListener("touchstart", (e) => onHandleDown("R", e), { passive: false });
document.addEventListener("mousemove", onHandleMove);
document.addEventListener("touchmove", onHandleMove, { passive: false });
document.addEventListener("mouseup",   onHandleUp);
document.addEventListener("touchend",  onHandleUp);

// Text input → trim sync
trimStartTxt.addEventListener("change", () => {
  if (!state.audioBuffer) return;
  const t = parseTime(trimStartTxt.value);
  if (t == null) { syncTrimUI(); return; }
  state.trim.start = Math.max(0, Math.min(t, state.trim.end - 0.1));
  syncTrimUI();
});
trimEndTxt.addEventListener("change", () => {
  if (!state.audioBuffer) return;
  const t = parseTime(trimEndTxt.value);
  if (t == null) { syncTrimUI(); return; }
  state.trim.end = Math.min(state.audioBuffer.duration, Math.max(t, state.trim.start + 0.1));
  syncTrimUI();
});
resetTrimBtn.addEventListener("click", () => {
  if (!state.audioBuffer) return;
  state.trim.start = 0;
  state.trim.end = state.audioBuffer.duration;
  syncTrimUI();
});

// Click on waveform to set play-cursor / scrub trim quickly:
// hold Shift = set start, hold Alt = set end, plain click = nothing (avoid
// accidental trim destruction).
waveformCanvas.addEventListener("click", (e) => {
  if (!state.audioBuffer) return;
  if (!e.shiftKey && !e.altKey) return;
  const rect = waveformCanvas.getBoundingClientRect();
  const t = ((e.clientX - rect.left) / rect.width) * state.audioBuffer.duration;
  if (e.shiftKey) state.trim.start = Math.max(0, Math.min(t, state.trim.end - 0.1));
  if (e.altKey)   state.trim.end   = Math.min(state.audioBuffer.duration, Math.max(t, state.trim.start + 0.1));
  syncTrimUI();
});

// ============ Bitrate / channels / bus / loop ============
function wireSeg(seg, setter) {
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-opt");
    if (!btn) return;
    seg.querySelectorAll(".seg-opt").forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    setter(btn);
  });
}
wireSeg(bitrateSeg, (b) => { state.bitrate  = parseInt(b.dataset.br, 10); updateSizeEstimate(); });
wireSeg(channelSeg, (b) => { state.channels = parseInt(b.dataset.ch, 10); });
wireSeg(busSeg,     (b) => { state.bus      = b.dataset.bus; });

function updateSizeEstimate() {
  const dur = Math.max(0, state.trim.end - state.trim.start);
  sizeEstimate.textContent = fmtBytes(estimateOpusBytes(dur, state.bitrate));
}

// ============ Preview ============
previewBtn.addEventListener("click", async () => {
  if (!state.audioBuffer) return;
  if (state.preview) { stopPreview(); return; }
  await getCtx().resume(); // unlock on iOS
  const src = getCtx().createBufferSource();
  src.buffer = state.audioBuffer;
  src.connect(getCtx().destination);
  const offset = state.trim.start;
  const length = Math.max(0, state.trim.end - state.trim.start);
  src.start(0, offset, length);
  state.preview = src;
  previewBtn.textContent = "■ 停止预览";
  playCursor.classList.add("playing");
  const startedAt = getCtx().currentTime;
  const tick = () => {
    if (state.preview !== src) return;
    const elapsed = getCtx().currentTime - startedAt;
    if (elapsed >= length) { stopPreview(); return; }
    const pxPerSec = waveformCanvas.clientWidth / state.audioBuffer.duration;
    playCursor.style.left = ((offset + elapsed) * pxPerSec) + "px";
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  src.onended = () => { if (state.preview === src) stopPreview(); };
});
function stopPreview() {
  if (state.preview) {
    try { state.preview.stop(); } catch {}
    state.preview = null;
  }
  previewBtn.textContent = "▶ 预览截取段";
  playCursor.classList.remove("playing");
}
cancelEditBtn.addEventListener("click", () => {
  stopPreview();
  state.currentFile = null;
  state.audioBuffer = null;
  editPanel.classList.add("hidden");
});

// ============ Encode + save ============
encodeBtn.addEventListener("click", async () => {
  if (!state.currentFile || !state.audioBuffer) return;
  if (state.trim.end - state.trim.start < 0.1) {
    toast("截取段过短", "warn");
    return;
  }
  stopPreview();
  encodeBtn.disabled = true;
  cancelEditBtn.disabled = true;
  encodeProg.classList.remove("hidden");
  encodeFill.style.width = "0%";
  encodeMsg.textContent = "准备中…";

  try {
    const blob = await encodeOpus(state.currentFile, {
      trimStart: state.trim.start,
      trimEnd:   state.trim.end,
      bitrate:   state.bitrate,
      channels:  state.channels,
      onProgress: (r, msg) => {
        encodeFill.style.width = (r * 100).toFixed(1) + "%";
        if (msg) encodeMsg.textContent = msg;
      },
    });
    const track = {
      id:       crypto.randomUUID(),
      name:     trackName.value.trim() || "未命名",
      bus:      state.bus,
      loop:     loopChk.checked,
      volume:   1,
      duration: state.trim.end - state.trim.start,
      bitrate:  state.bitrate,
      bytes:    blob.size,
      mime:     blob.type,
      blob,
      origName: state.currentFile.name,
      trim:     { start: state.trim.start, end: state.trim.end },
      ts:       Date.now(),
    };
    await addTrack(track);
    toast(`「${track.name}」已加入库（${fmtBytes(blob.size)}）`, "ok");
    cancelEditBtn.click();
    await refreshLibrary();
  } catch (err) {
    console.error("encode failed", err);
    toast("编码失败：" + (err?.message || err), "error");
  } finally {
    encodeBtn.disabled = false;
    cancelEditBtn.disabled = false;
    encodeProg.classList.add("hidden");
  }
});

// ============ URL source ============
urlInput.addEventListener("input", () => {
  const v = urlInput.value.trim();
  urlAddBtn.disabled = !/^https?:\/\//i.test(v);
});
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !urlAddBtn.disabled) urlAddBtn.click();
});
urlAddBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!/^https?:\/\//i.test(url)) return;
  // Derive a name from the URL path; user can rename later via the library.
  let name = "外链音乐";
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length) name = decodeURIComponent(segs[segs.length - 1]).replace(/\.[a-z0-9]{1,5}$/i, "");
  } catch {}
  const track = {
    id:       crypto.randomUUID(),
    name,
    bus:      "bgm",
    loop:     true,
    volume:   1,
    duration: 0,
    bitrate:  0,
    bytes:    0,
    mime:     "audio/*",
    url,
    origName: url,
    ts:       Date.now(),
  };
  await addTrack(track);
  toast(`已添加外链「${name}」`, "ok");
  urlInput.value = "";
  urlAddBtn.disabled = true;
  await refreshLibrary();
});
urlAddBtn.disabled = true;

// ============ Library ============
let _libCache = [];
let _libPlayer = null; // currently-playing <audio>
let _libPlayingId = null;

async function refreshLibrary() {
  _libCache = await listTracks();
  renderLibrary();
}

function filteredLib() {
  let arr = _libCache;
  if (state.libFilter !== "all") arr = arr.filter((t) => t.bus === state.libFilter);
  if (state.libSearchStr) {
    const q = state.libSearchStr.toLowerCase();
    arr = arr.filter((t) =>
      (t.name || "").toLowerCase().includes(q) ||
      (t.origName || "").toLowerCase().includes(q));
  }
  return arr;
}

function renderLibrary() {
  const arr = filteredLib();
  libGrid.innerHTML = "";
  if (arr.length === 0) {
    const empty = document.createElement("div");
    empty.className = "lib-empty";
    empty.textContent = _libCache.length === 0
      ? "库是空的——上面拖入文件或粘贴 URL 就会出现在这里。"
      : "没有匹配的曲目。";
    libGrid.appendChild(empty);
    return;
  }
  for (const t of arr) libGrid.appendChild(makeLibItem(t));
}

function makeLibItem(t) {
  const card = document.createElement("div");
  card.className = "lib-item";
  card.dataset.id = t.id;

  const head = document.createElement("div");
  head.className = "lib-item-head";
  const nameEl = document.createElement("div");
  nameEl.className = "lib-item-name";
  nameEl.textContent = t.name;
  nameEl.title = t.origName || t.name;
  nameEl.contentEditable = "true";
  nameEl.spellcheck = false;
  nameEl.addEventListener("blur", async () => {
    const newName = nameEl.textContent.trim();
    if (newName && newName !== t.name) {
      t.name = newName;
      // Mutate cache + persist.
      const { updateTrack } = await import("./library.js");
      await updateTrack(t.id, { name: newName });
    } else {
      nameEl.textContent = t.name;
    }
  });
  nameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); nameEl.blur(); }
  });
  const busEl = document.createElement("span");
  busEl.className = "lib-item-bus " + (t.url ? "url" : t.bus);
  busEl.textContent = t.url ? "URL" : t.bus.toUpperCase();
  head.appendChild(nameEl); head.appendChild(busEl);

  const meta = document.createElement("div");
  meta.className = "lib-item-meta";
  const bits = [];
  if (t.duration) bits.push(fmtTime(t.duration));
  if (t.bitrate)  bits.push(t.bitrate + "k");
  if (t.bytes)    bits.push(fmtBytes(t.bytes));
  if (t.url)      bits.push("外链");
  meta.innerHTML = bits.map((b, i) => i === 0 ? `<span>${b}</span>` : `<span class="dot">·</span><span>${b}</span>`).join("");

  const actions = document.createElement("div");
  actions.className = "lib-item-actions";

  const playBtn = document.createElement("button");
  playBtn.className = "ic-btn primary";
  playBtn.innerHTML = _libPlayingId === t.id ? "■" : "▶";
  playBtn.title = "播放 / 停止";
  playBtn.addEventListener("click", () => toggleLibPlay(t));
  actions.appendChild(playBtn);

  const shareBtn = document.createElement("button");
  shareBtn.className = "ic-btn";
  shareBtn.textContent = "码";
  shareBtn.title = "生成枭熊导入码";
  shareBtn.addEventListener("click", () => showShareCode([t]));
  actions.appendChild(shareBtn);

  const dlBtn = document.createElement("button");
  dlBtn.className = "ic-btn";
  dlBtn.textContent = "↓";
  dlBtn.title = "下载 .opus 文件（拿去上传到自己的空间）";
  dlBtn.disabled = !t.blob;
  dlBtn.addEventListener("click", () => downloadTrack(t));
  actions.appendChild(dlBtn);

  const delBtn = document.createElement("button");
  delBtn.className = "ic-btn danger";
  delBtn.textContent = "×";
  delBtn.title = "从库中删除";
  delBtn.addEventListener("click", async () => {
    if (!confirm(`确定要删除「${t.name}」吗？`)) return;
    if (_libPlayingId === t.id) stopLibPlay();
    await deleteTrack(t.id);
    await refreshLibrary();
  });
  actions.appendChild(delBtn);

  card.appendChild(head);
  card.appendChild(meta);
  card.appendChild(actions);
  return card;
}

function toggleLibPlay(t) {
  if (_libPlayingId === t.id) { stopLibPlay(); return; }
  stopLibPlay();
  const audio = document.createElement("audio");
  audio.preload = "auto";
  audio.crossOrigin = "anonymous"; // best-effort; failures still play, just no fetch
  audio.src = t.url || URL.createObjectURL(t.blob);
  audio.loop = !!t.loop;
  audio.volume = Math.max(0, Math.min(1, t.volume ?? 1));
  audio.play().catch((e) => {
    toast("播放失败：" + (e?.message || e), "error");
    stopLibPlay();
  });
  audio.addEventListener("ended", () => { if (!audio.loop) stopLibPlay(); });
  _libPlayer = audio;
  _libPlayingId = t.id;
  renderLibrary();
}
function stopLibPlay() {
  if (_libPlayer) {
    try { _libPlayer.pause(); } catch {}
    if (_libPlayer.src.startsWith("blob:")) URL.revokeObjectURL(_libPlayer.src);
    _libPlayer = null;
  }
  if (_libPlayingId) { _libPlayingId = null; renderLibrary(); }
}

function downloadTrack(t) {
  if (!t.blob) return;
  const url = URL.createObjectURL(t.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (t.name || "audio").replace(/[\\/:*?"<>|]/g, "_") + ".opus";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 0);
}

libSearch.addEventListener("input", () => {
  state.libSearchStr = libSearch.value.trim();
  renderLibrary();
});
wireSeg(libFilterSeg, (b) => {
  state.libFilter = b.dataset.flt;
  renderLibrary();
});
exportAllBtn.addEventListener("click", () => {
  const exportable = _libCache.filter((t) => t.url);
  if (exportable.length === 0) {
    toast("库里没有可分享的外链/已上传曲目。本地压缩曲目需要先下载并上传到自己的空间。", "warn");
    return;
  }
  showShareCode(exportable, true);
});

// ============ Share modal ============
let _currentCode = "";
function showShareCode(tracks, multi = false) {
  try {
    _currentCode = encodeShareCode(tracks);
  } catch (e) {
    toast(e.message || "无法生成导入码", "error");
    return;
  }
  shareTitle.textContent = multi
    ? `枭熊导入码（${tracks.length} 首）`
    : "枭熊导入码";
  shareCode.value = _currentCode;
  shareMeta.textContent =
    `${tracks.length} 首 · 编码长度 ${_currentCode.length} 字符`;
  shareModal.classList.remove("hidden");
  setTimeout(() => { shareCode.focus(); shareCode.select(); }, 30);
}
shareModal.addEventListener("click", (e) => {
  if (e.target.matches("[data-close]")) shareModal.classList.add("hidden");
});
copyShareBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(_currentCode);
    toast("已复制到剪贴板", "ok");
  } catch {
    shareCode.focus();
    shareCode.select();
    document.execCommand("copy");
    toast("已尝试复制（如未生效请手动选中文本）", "warn");
  }
});

// ============ Boot ============
refreshLibrary().catch((e) => {
  console.error("library load failed", e);
  toast("库加载失败：" + (e?.message || e), "error");
});
