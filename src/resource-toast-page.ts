// Resource toast — bottom-center fullscreen overlay that pops a
// card every time someone in the room changes a resource value.
//
// Hosted in a fullScreen + disablePointerEvents OBR.modal opened by
// the bg (resourceTracker setup). Listens for `BC_RESOURCE_CHANGED`
// LOCAL+REMOTE; renders ONE toast per change. Multiple concurrent
// toasts arrange horizontally at the bottom-center.
//
// 2026-05-12 — toast now renders the SAME WIDGET as the panel row
// (count pills / draggable bar / number bar) instead of just a
// number summary. User explicitly asked for "完全照搬" parity.
// Hold time also bumped 2.5s → 5s and the bottom offset 24 → 96 px
// (raised) so OBR's native bottom toolbar isn't covered.

import OBR from "@owlbear-rodeo/sdk";
import { ICON_LIBRARY } from "./modules/resourceTracker/icons";
import type { Resource, IconId } from "./modules/resourceTracker/types";

const BC_RESOURCE_CHANGED = "com.obr-suite/resources/changed";
const TOAST_HOLD_MS = 5000;     // 2.5 → 5 s per user spec
const TOAST_FADE_MS = 280;
const MAX_VISIBLE = 6;

interface ResourceToastPayload {
  tokenId: string;
  tokenName?: string;
  resource: Resource;
  delta: number;
  prevValue: number;
}

const stackEl = document.getElementById("stack") as HTMLDivElement;

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}

function classifyDelta(delta: number): "delta-up" | "delta-down" | "delta-zero" {
  if (delta > 0) return "delta-up";
  if (delta < 0) return "delta-down";
  return "delta-zero";
}

function deltaText(delta: number): string {
  if (delta === 0) return "";
  return delta > 0 ? `+${delta}` : `${delta}`;
}

// === Widget renderers — visual parity with panel.ts ====================
//
// These produce read-only HTML that mirrors what the user just clicked
// in the resource panel. The toast doesn't bind any event listeners;
// CSS `pointer-events:none` on `.widget` neutralises hover effects so
// the cards read as static notifications.

function renderCountWidget(r: Resource): string {
  const max = Math.max(0, Math.floor(r.max));
  const cur = Math.max(0, Math.min(max, Math.floor(r.current)));
  const cells: string[] = [];
  for (let i = 1; i <= max; i++) {
    const filled = i <= cur;
    cells.push(`
      <span class="rt-pill-icon ${filled ? "full" : "spent"}">
        ${ICON_LIBRARY[r.icon as IconId] ?? ICON_LIBRARY.gem}
      </span>
    `);
  }
  return `<div class="rt-pills">${cells.join("")}</div>`;
}

function renderBarWidget(r: Resource): string {
  const max = Math.max(1, r.max);
  const cur = Math.max(0, Math.min(max, r.current));
  const ratio = (cur / max) * 100;
  return `
    <div class="rt-bar-row">
      <div class="rt-bar-num">${cur} / ${max}</div>
      <div class="rt-bar">
        <div class="rt-bar-fill" style="width:${ratio.toFixed(1)}%"></div>
        <span class="rt-bar-thumb" style="left:${ratio.toFixed(2)}%">
          ${ICON_LIBRARY[r.icon as IconId] ?? ICON_LIBRARY.gem}
        </span>
      </div>
    </div>
  `;
}

function renderNumberWidget(r: Resource): string {
  const min = 0;
  const max = Math.max(0, r.max);
  const cur = r.current;
  return `
    <div class="rt-num-bar">
      <span class="rt-num-end">${min}</span>
      <span class="rt-num-step">−</span>
      <span class="rt-num-orb">
        <span class="rt-num-orb-icon">${ICON_LIBRARY[r.icon as IconId] ?? ICON_LIBRARY.gem}</span>
        <span class="rt-num-orb-val">${cur}</span>
      </span>
      <span class="rt-num-step">+</span>
      <span class="rt-num-end">${max}</span>
    </div>
  `;
}

function renderWidget(r: Resource): string {
  if (r.type === "count")  return renderCountWidget(r);
  if (r.type === "bar")    return renderBarWidget(r);
  if (r.type === "number") return renderNumberWidget(r);
  return "";
}

function showToast(p: ResourceToastPayload): void {
  const cls = classifyDelta(p.delta);
  const r = p.resource;
  const el = document.createElement("div");
  el.className = `toast ${cls}`;
  el.innerHTML = `
    <div class="head">
      <span class="name">${escapeHtml(r.name || "(未命名)")}</span>
      ${p.tokenName ? `<span class="who">· ${escapeHtml(p.tokenName)}</span>` : ""}
      <span class="delta">${escapeHtml(deltaText(p.delta))}</span>
    </div>
    <div class="widget">${renderWidget(r)}</div>
  `;

  // Cap the on-screen count.
  while (stackEl.children.length >= MAX_VISIBLE) {
    const oldest = stackEl.firstElementChild;
    if (!oldest) break;
    oldest.remove();
  }
  stackEl.appendChild(el);
  // Force a reflow so the .is-in transition runs.
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  el.offsetWidth;
  el.classList.add("is-in");

  setTimeout(() => {
    el.classList.remove("is-in");
    el.classList.add("is-out");
    setTimeout(() => { try { el.remove(); } catch {} }, TOAST_FADE_MS);
  }, TOAST_HOLD_MS);
}

OBR.onReady(() => {
  OBR.broadcast.onMessage(BC_RESOURCE_CHANGED, (event) => {
    const data = event.data as ResourceToastPayload | undefined;
    if (!data || !data.resource || typeof data.delta !== "number") return;
    showToast(data);
  });
});
