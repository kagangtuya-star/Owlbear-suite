/* Supporter overlay — fullscreen ambient backdrop with floating names.
 *
 * Lifecycle (owned by cluster-row.ts):
 *   - Opened as fullscreen modal alongside settings popover.
 *   - Stays at opacity 0 until settings broadcasts visibility=true
 *     (user is on the Support / Feedback tab).
 *   - On visibility=false, fades names out + scene opacity to 0.
 *   - When settings popover closes, cluster-row.ts closes this modal
 *     entirely.
 *
 * Visual:
 *   - Black radial gradient backdrop (only when visible)
 *   - All supporters' names floating at random positions OUTSIDE the
 *     centred 640×580 settings popover bbox.
 *   - Each name has tier-coloured glow + fade-in / hold / fade-out
 *     cycle. New names spawn continuously to refresh the wall.
 *   - Pointer events are disabled (passed-through to canvas) by OBR's
 *     modal config `disablePointerEvents: true`.
 */

import OBR from "@owlbear-rodeo/sdk";
import { assetUrl } from "./asset-base";

interface Supporter { name: string; amount: number; }

const BC_VISIBILITY = "com.obr-suite/supporter-overlay/visibility";

// === Tier / size helpers (mirror of settings.ts) ===================

function supporterTier(amount: number): "t1" | "t2" | "t3" | "t4" | "t5" {
  if (amount >= 100) return "t5";
  if (amount >= 50)  return "t4";
  if (amount >= 30)  return "t3";
  if (amount >= 20)  return "t2";
  return "t1";
}

function supporterFontSize(amount: number): number {
  // Same sqrt curve as settings.ts. Slightly LARGER ceiling on the
  // overlay because we're on a fullscreen backdrop instead of a
  // 640px popup — bigger names read better at that scale.
  const raw = 10 + 2.5 * Math.sqrt(Math.max(0, amount));
  return Math.max(13, Math.min(46, Math.round(raw * 10) / 10));
}

// === Load supporter list ===========================================

let supporters: Supporter[] = [];

async function loadSupporters(lang: string): Promise<void> {
  const file = lang === "en" ? "supporters.en.json" : "supporters.zh.json";
  try {
    const r = await fetch(assetUrl(file), { cache: "no-cache" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const arr = await r.json();
    if (Array.isArray(arr)) {
      supporters = arr
        .map((v: any) => {
          if (!v || typeof v.name !== "string") return null;
          const a = Number(v.amount);
          return { name: v.name.trim(), amount: Number.isFinite(a) ? a : 10 };
        })
        .filter((v: any): v is Supporter => !!v && v.name.length > 0);
    }
  } catch (e) {
    console.warn("[supporter-overlay] supporter load failed", e);
    supporters = [];
  }
}

// === Popup "hole" computation =====================================
//
// Settings popover is anchored at viewport centre, 640×580. We
// reserve a slightly-larger rectangle around it so names don't
// crowd the visible edges of the panel.

function getHoleRect(): { x: number; y: number; w: number; h: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const popupW = 640;
  const popupH = 580;
  const margin = 24;  // safety padding so names don't peek under the panel border
  const w = popupW + margin * 2;
  const h = popupH + margin * 2;
  return {
    x: (vw - w) / 2,
    y: (vh - h) / 2,
    w, h,
  };
}

// === Name placement ================================================
//
// Pick a random point in the viewport that's OUTSIDE the popup
// rectangle AND keeps the entire name on-screen (using an estimate
// of the name's rendered width).

function pickPosition(estimatedW: number, estimatedH: number): { x: number; y: number } | null {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const hole = getHoleRect();
  // Try up to N times to find a non-overlapping spot.
  for (let attempt = 0; attempt < 30; attempt++) {
    const x = Math.random() * (vw - estimatedW);
    const y = Math.random() * (vh - estimatedH);
    // Check if the name's bbox overlaps the popup hole.
    if (
      x + estimatedW < hole.x ||
      x > hole.x + hole.w ||
      y + estimatedH < hole.y ||
      y > hole.y + hole.h
    ) {
      return { x, y };
    }
  }
  // Failsafe: place far from centre.
  const corner = Math.floor(Math.random() * 4);
  const padding = 12;
  switch (corner) {
    case 0: return { x: padding,                          y: padding };
    case 1: return { x: vw - estimatedW - padding,        y: padding };
    case 2: return { x: padding,                          y: vh - estimatedH - padding };
    default:return { x: vw - estimatedW - padding,        y: vh - estimatedH - padding };
  }
}

// Rough estimate of a name's bounding box — used by pickPosition
// before the element is in the DOM. Good enough for placement
// (overshoots slightly which makes names err on the spread side).
function estimateBox(s: Supporter): { w: number; h: number } {
  const fs = supporterFontSize(s.amount);
  // ~0.65 of fontSize per glyph for CJK + a bit, plus padding.
  const charW = fs * 0.85;
  const w = Math.max(60, s.name.length * charW + 16);
  const h = fs * 1.4 + 4;
  return { w, h };
}

// === Animated name pool ============================================
//
// A pool of N "slots" — each slot independently picks a random
// supporter, fades in, holds, fades out, then re-rolls. Continuous
// rotation keeps the wall feeling alive without doing one mass
// flash.

const sceneEl = document.getElementById("scene") as HTMLDivElement;

interface Slot {
  el: HTMLDivElement;
  state: "void" | "in" | "hold" | "out";
  stateUntil: number;       // ms timestamp
  current: Supporter | null;
}

const slots: Slot[] = [];

function makeSlot(): Slot {
  const el = document.createElement("div");
  el.className = "name";
  sceneEl.appendChild(el);
  return { el, state: "void", stateUntil: 0, current: null };
}

function pickSupporter(): Supporter | null {
  if (supporters.length === 0) return null;
  // Weight by sqrt(amount) so higher tiers appear MORE OFTEN (but
  // not totally dominate). Bump everyone with a base weight so even
  // ¥0 / ¥1 names cycle in.
  let total = 0;
  for (const s of supporters) total += 1 + Math.sqrt(s.amount);
  let pick = Math.random() * total;
  for (const s of supporters) {
    const w = 1 + Math.sqrt(s.amount);
    if (pick < w) return s;
    pick -= w;
  }
  return supporters[supporters.length - 1];
}

function placeSlot(slot: Slot, s: Supporter): void {
  const tier = supporterTier(s.amount);
  const fs = supporterFontSize(s.amount);
  const box = estimateBox(s);
  const pos = pickPosition(box.w, box.h) ?? { x: 20, y: 20 };
  slot.el.className = `name ${tier}`;
  slot.el.style.fontSize = `${fs}px`;
  slot.el.style.left = `${pos.x}px`;
  slot.el.style.top = `${pos.y}px`;
  slot.el.textContent = s.name;
  slot.current = s;
}

function tickSlot(slot: Slot, now: number): void {
  if (slot.state === "void") {
    // Pick a new supporter, place it, start fade-in.
    const s = pickSupporter();
    if (!s) return;
    placeSlot(slot, s);
    // Force a reflow so the opacity transition kicks in from 0 → 1.
    void slot.el.offsetWidth;
    slot.el.style.opacity = "1";
    // Tier 5 → longer hold (special supporters get more screen time).
    const tier = supporterTier(s.amount);
    const holdMs = tier === "t5" ? 6500
                 : tier === "t4" ? 5500
                 : tier === "t3" ? 4500
                 : 3500;
    slot.state = "in";
    slot.stateUntil = now + 1200 + holdMs;  // 1.2 s fade-in + hold
    // After hold, schedule fade-out.
    setTimeout(() => {
      slot.el.style.opacity = "0";
      slot.state = "out";
      slot.stateUntil = now + 1200 + holdMs + 1500;  // 1.5 s fade-out window
    }, 1200 + holdMs);
    return;
  }
  if (slot.state === "out" && now >= slot.stateUntil) {
    slot.state = "void";
    slot.stateUntil = now + Math.random() * 800;  // brief pause before respawn
  }
}

// === Animation loop ================================================

let _rafHandle = 0;
function loop() {
  const now = performance.now();
  for (const s of slots) tickSlot(s, now);
  _rafHandle = requestAnimationFrame(loop);
}

function startLoop() {
  if (_rafHandle) return;
  loop();
}
function stopLoop() {
  if (_rafHandle) {
    cancelAnimationFrame(_rafHandle);
    _rafHandle = 0;
  }
}

// === Visibility coordination ======================================

function setVisible(visible: boolean): void {
  if (visible) {
    sceneEl.classList.add("visible");
    // Stagger initial slot spawns over the first ~3.5 seconds so all
    // 32 names don't pop in on the same frame. Putting each slot in
    // "out" state with a random stateUntil makes the rAF loop trigger
    // spawn (void state) at a randomised time.
    const now = performance.now();
    for (const s of slots) {
      s.state = "out";
      s.stateUntil = now + Math.random() * 3500;
      s.el.style.opacity = "0";
    }
    startLoop();
  } else {
    sceneEl.classList.remove("visible");
    setTimeout(() => {
      if (!sceneEl.classList.contains("visible")) {
        stopLoop();
        for (const s of slots) {
          s.el.style.opacity = "0";
          s.state = "void";
          s.stateUntil = 0;
        }
      }
    }, 700);
  }
}

// === Resize handler ===============================================
// Re-anchor the popup-hole rectangle on viewport resize. Existing
// names stay where they are; new spawns use the updated hole.
// (Cheap to leave existing names possibly overlapping the new hole
// for a few seconds — they'll cycle out and respawn in valid spots.)
window.addEventListener("resize", () => { /* getHoleRect reads live */ });

// === Boot =========================================================

const SLOT_COUNT = 32;   // 32 names visible+cycling simultaneously

OBR.onReady(async () => {
  // Default to ZH; broadcast carries the actual choice from settings.
  await loadSupporters("zh");

  // Build the slot pool now that we know we have supporters.
  for (let i = 0; i < SLOT_COUNT; i++) slots.push(makeSlot());

  OBR.broadcast.onMessage(BC_VISIBILITY, async (event) => {
    const data = event.data as { visible?: boolean; lang?: string } | undefined;
    if (!data) return;
    // Reload supporters list only if lang actually changed. Compare
    // BEFORE updating `_lastLoadedLang` so the equality check works.
    if ((data.lang === "zh" || data.lang === "en") && data.lang !== _lastLoadedLang) {
      _lastLoadedLang = data.lang;
      await loadSupporters(data.lang);
    }
    setVisible(!!data.visible);
  });
});

let _lastLoadedLang: "zh" | "en" = "zh";
