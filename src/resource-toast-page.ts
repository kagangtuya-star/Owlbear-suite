// Resource toast — bottom-center fullscreen overlay that pops a small
// card every time someone in the room changes a resource value.
//
// Hosted in a fullScreen + disablePointerEvents OBR.modal opened by
// the bg (resourceTracker setup). Listens for `BC_RESOURCE_CHANGED`
// LOCAL+REMOTE; renders one toast per change. Multiple concurrent
// toasts arrange horizontally at the bottom-center.
//
// Animation timeline per toast:
//   0 ms       insert with .is-in queued for next rAF
//   +28 ms     fade-in + slide-up complete
//   +2500 ms   add .is-out → fade-out + slight rise
//   +2780 ms   remove from DOM
//
// 2026-05-11.

import OBR from "@owlbear-rodeo/sdk";
import { ICON_LIBRARY } from "./modules/resourceTracker/icons";
import type { Resource, IconId } from "./modules/resourceTracker/types";

const BC_RESOURCE_CHANGED = "com.obr-suite/resources/changed";
const TOAST_HOLD_MS = 2500;
const TOAST_FADE_MS = 280;
const MAX_VISIBLE = 6;

interface ResourceToastPayload {
  // Snake-case-ish object that the resource panel emits when a value
  // commits. The toast renders a tiny "icon + name + cur/max +
  // delta" card from this.
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

function showToast(p: ResourceToastPayload): void {
  const cls = classifyDelta(p.delta);
  const r = p.resource;
  const iconSvg = ICON_LIBRARY[r.icon as IconId] ?? ICON_LIBRARY.gem;
  const tokenLine = p.tokenName ? `${escapeHtml(p.tokenName)} · ${escapeHtml(r.name || "(未命名)")}` : escapeHtml(r.name || "(未命名)");
  const el = document.createElement("div");
  el.className = `toast ${cls}`;
  el.innerHTML = `
    <span class="ic">${iconSvg}</span>
    <div class="body">
      <div class="title">${escapeHtml(r.name || "(未命名)")}</div>
      <div class="sub">${escapeHtml(p.tokenName ?? "")}</div>
      <div class="vals">
        <span class="cur">${r.current}</span>
        <span class="sep">/</span>
        <span class="max">${r.max}</span>
      </div>
    </div>
    <span class="delta">${escapeHtml(deltaText(p.delta))}</span>
  `;
  // Discard the unused tokenLine to silence the lint while still
  // giving consumers a single-string title to copy from later.
  void tokenLine;

  // Cap the on-screen count — older toasts get fast-forwarded out.
  while (stackEl.children.length >= MAX_VISIBLE) {
    const oldest = stackEl.firstElementChild;
    if (!oldest) break;
    oldest.remove();
  }
  stackEl.appendChild(el);
  // Force a reflow so the .is-in transition runs (otherwise the
  // initial classes apply too early and the slide-up fizzles).
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  el.offsetWidth;
  el.classList.add("is-in");

  setTimeout(() => {
    el.classList.remove("is-in");
    el.classList.add("is-out");
    setTimeout(() => {
      try { el.remove(); } catch {}
    }, TOAST_FADE_MS);
  }, TOAST_HOLD_MS);
}

OBR.onReady(() => {
  OBR.broadcast.onMessage(BC_RESOURCE_CHANGED, (event) => {
    const data = event.data as ResourceToastPayload | undefined;
    if (!data || !data.resource || typeof data.delta !== "number") return;
    showToast(data);
  });
});
