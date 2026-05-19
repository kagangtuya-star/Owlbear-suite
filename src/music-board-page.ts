/* Music Board plugin page — thin viewer.
 *
 * The real engine lives in the background plugin iframe
 * (src/modules/musicBoard/engine.ts) so audio + PeerJS survive popover
 * open/close cycles. This page only:
 *   • Subscribes to "com.obr-suite/music-board:state" broadcasts and
 *     renders the latest snapshot.
 *   • Sends commands ("state-request", "pair-connect", "pair-disconnect",
 *     "local-vol") on "com.obr-suite/music-board:cmd".
 *
 * Closing the popover destroys this iframe but the background engine
 * keeps playing and stays connected to the studio.
 */
import OBR from "@owlbear-rodeo/sdk";

const BC_CMD   = "com.obr-suite/music-board:cmd";
const BC_STATE = "com.obr-suite/music-board:state";

interface Snapshot {
  bgm: { url: string; name: string; loop: boolean; paused: boolean;
         currentTime: number; duration: number } | null;
  sfxCount: number;
  bus:      { bgm: number; sfx: number };
  localVol: { bgm: number; sfx: number; mute: boolean };
  pair: {
    status: "idle" | "loading" | "connecting" | "live" | "error";
    code: string;
    errorMsg: string;
  };
}

const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector(s) as T;

const npCard      = $("#npCard");
const npStatus    = $("#npStatus");
const npTitle     = $("#npTitle");
const npTime      = $("#npTime");
const bgmVol      = $("#bgmVol") as HTMLInputElement;
const bgmVolReadout = $("#bgmVolReadout");
const sfxVol      = $("#sfxVol") as HTMLInputElement;
const sfxVolReadout = $("#sfxVolReadout");
const muteChk     = $("#muteChk") as HTMLInputElement;
const pairStatusEl = $("#pairStatus");
const pairCodeEl  = $("#pairCode") as HTMLInputElement;
const pairBtn     = $("#pairBtn") as HTMLButtonElement;
const unpairBtn   = $("#unpairBtn") as HTMLButtonElement;
const toastStack  = $("#toastStack");

let snap: Snapshot | null = null;

function sendCmd(data: any) {
  try { OBR.broadcast.sendMessage(BC_CMD, data, { destination: "LOCAL" }); }
  catch (e) { console.warn("[music-board page] send cmd failed", e); }
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s - m * 60);
  return `${pad2(m)}:${pad2(sec)}`;
}
function pad2(n: number) { return n < 10 ? "0" + n : "" + n; }

function toast(text: string, kind: "ok" | "warn" | "error" | "" = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = text;
  toastStack.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s, transform .25s";
    el.style.opacity = "0"; el.style.transform = "translateY(6px)";
    setTimeout(() => el.remove(), 260);
  }, 2400);
}

let lastErrorShown = "";

function render() {
  if (!snap) return;

  // BGM card
  if (snap.bgm) {
    const playing = !snap.bgm.paused;
    npCard.classList.toggle("playing", playing);
    npStatus.textContent = playing ? "正在播放" : "已暂停";
    npTitle.textContent = snap.bgm.name || "未命名 BGM";
    if (snap.bgm.duration > 0) {
      npTime.textContent = `${fmtTime(snap.bgm.currentTime)} / ${fmtTime(snap.bgm.duration)}`;
    } else {
      npTime.textContent = `${fmtTime(snap.bgm.currentTime)} / --:--`;
    }
  } else {
    npCard.classList.remove("playing");
    npStatus.textContent = "空闲";
    npTitle.textContent = "没有 BGM 在播放";
    npTime.textContent = "--:-- / --:--";
  }

  // Local volume controls — only sync from snapshot if the value
  // differs from what the user currently has set (don't fight user
  // interaction in flight).
  syncSlider(bgmVol, bgmVolReadout, Math.round(snap.localVol.bgm * 100));
  syncSlider(sfxVol, sfxVolReadout, Math.round(snap.localVol.sfx * 100));
  if (muteChk.checked !== snap.localVol.mute) muteChk.checked = snap.localVol.mute;

  // Pair widget — code/status drive button visibility + the readout.
  pairCodeEl.value = snap.pair.code;
  pairStatusEl.classList.remove("live", "connecting", "error");
  switch (snap.pair.status) {
    case "idle":
      pairStatusEl.textContent = "未连接";
      pairBtn.style.display = "";
      unpairBtn.style.display = "none";
      pairBtn.disabled = pairCodeEl.value.trim().length < 4;
      pairBtn.textContent = "连接";
      break;
    case "loading":
      pairStatusEl.textContent = "加载…";
      pairStatusEl.classList.add("connecting");
      pairBtn.style.display = "";
      unpairBtn.style.display = "none";
      pairBtn.disabled = true;
      pairBtn.textContent = "连接中…";
      break;
    case "connecting":
      pairStatusEl.textContent = "拨号 " + snap.pair.code + "…";
      pairStatusEl.classList.add("connecting");
      pairBtn.style.display = "";
      unpairBtn.style.display = "";
      pairBtn.disabled = true;
      pairBtn.textContent = "连接中…";
      break;
    case "live":
      pairStatusEl.textContent = "已连接 " + snap.pair.code;
      pairStatusEl.classList.add("live");
      pairBtn.style.display = "none";
      unpairBtn.style.display = "";
      break;
    case "error":
      pairStatusEl.textContent = "错误";
      pairStatusEl.classList.add("error");
      pairBtn.style.display = "";
      unpairBtn.style.display = "none";
      pairBtn.disabled = pairCodeEl.value.trim().length < 4;
      pairBtn.textContent = "重试";
      if (snap.pair.errorMsg && snap.pair.errorMsg !== lastErrorShown) {
        toast("配对失败：" + snap.pair.errorMsg, "error");
        lastErrorShown = snap.pair.errorMsg;
      }
      break;
  }
}

function syncSlider(el: HTMLInputElement, readout: HTMLElement | null, target: number) {
  if (document.activeElement === el) return; // user is dragging
  const curr = Number(el.value);
  if (curr !== target) {
    el.value = String(target);
    if (readout) readout.textContent = String(target);
  }
}

// ---- User interactions -------------------------------------------
bgmVol.addEventListener("input", () => {
  if (bgmVolReadout) bgmVolReadout.textContent = bgmVol.value;
  sendCmd({ type: "local-vol", bgm: Number(bgmVol.value) / 100 });
});
sfxVol.addEventListener("input", () => {
  if (sfxVolReadout) sfxVolReadout.textContent = sfxVol.value;
  sendCmd({ type: "local-vol", sfx: Number(sfxVol.value) / 100 });
});
muteChk.addEventListener("change", () => {
  sendCmd({ type: "local-vol", mute: muteChk.checked });
});

pairCodeEl.addEventListener("input", () => {
  const cleaned = pairCodeEl.value.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (cleaned !== pairCodeEl.value) pairCodeEl.value = cleaned;
  pairBtn.disabled = pairCodeEl.value.trim().length < 4;
});
pairCodeEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !pairBtn.disabled) pairBtn.click();
});
pairBtn.addEventListener("click", () => {
  const code = pairCodeEl.value.trim();
  if (code.length < 4) { toast("配对码至少 4 位", "warn"); return; }
  lastErrorShown = "";
  sendCmd({ type: "pair-connect", code });
});
unpairBtn.addEventListener("click", () => {
  sendCmd({ type: "pair-disconnect" });
});

// ---- Boot ---------------------------------------------------------
OBR.onReady(() => {
  // Subscribe to engine snapshots.
  try {
    OBR.broadcast.onMessage(BC_STATE, (event: any) => {
      snap = event?.data as Snapshot;
      render();
    });
  } catch (e) {
    console.warn("[music-board page] broadcast subscribe failed", e);
  }
  // Ask engine for a snapshot immediately so we render with real
  // state instead of placeholders.
  sendCmd({ type: "state-request" });
});

// Safety fallback if engine never responds (e.g. OBR context missing).
setTimeout(() => {
  if (!snap) {
    toast("等待引擎状态…（如果一直无响应，关掉重开音乐板）", "warn");
  }
}, 1500);
