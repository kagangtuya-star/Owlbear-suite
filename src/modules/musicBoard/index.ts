/* Music-board module — background side.
 *
 * Cluster-row "音乐" button → BC_TOGGLE (LOCAL) → flips room-wide
 * `open` flag in scene metadata. All clients react to the metadata
 * change by opening / closing their own music-board popover (which
 * carries the live audio + PeerJS pairing). Players never write the
 * open flag, never see the cluster button, never close their popover
 * — only DM controls visibility for the whole room.
 *
 * Audio + PeerJS live in the popover (music-board-page.ts) because
 * WebAudio autoplay needs a user gesture in THAT iframe. Background
 * just owns the open-flag + popover anchor.
 *
 * Layout: registers as a draggable panel via PANEL_IDS.musicBoard.
 * The popover anchor is `vw - RIGHT_INSET + userOff.dx` so user drags
 * persist across open/close.
 */

import OBR from "@owlbear-rodeo/sdk";
import { assetUrl } from "../../asset-base";
import {
  PANEL_IDS,
  getPanelOffset,
  registerPanelBbox,
  BC_PANEL_DRAG_END,
  BC_PANEL_RESET,
} from "../../utils/panelLayout";

interface DragEndPayload { panelId?: string; }

const POPOVER_ID = "com.obr-suite/music-board/popover";
const PAGE_URL   = assetUrl("music-board.html");
// IMPORTANT: keep this metadata key SEPARATE from the music-state key
// the popover writes. The popover overwrites its entire key on every
// peer message; if we shared a key our `open` flag would be lost on
// the first bgm-load and the popover would auto-close.
const META_KEY_OPEN  = "com.obr-suite/music-board:open";
const META_KEY_STATE = "com.obr-suite/music-board:state";
const BC_TOGGLE      = "com.obr-suite/music-board:toggle";
const BC_ACTIVE      = "com.obr-suite/music-board:state-active";

// Dimensions differ by role: the player popover has no pair-section
// (CSS hides it) so it can be much shorter. The width stays the same
// so the layout doesn't reflow inside.
const POPOVER_W      = 380;
const POPOVER_H_GM   = 540;
const POPOVER_H_PLYR = 300;
// Clear OBR's right-side panels (people / scene settings) — 120 px
// gap leaves the popover well off the toolbar.
const RIGHT_INSET    = 120;
const TOP_INSET      = 56;

let popoverOpen = false;
let myRole: "GM" | "PLAYER" = "PLAYER";
const unsubs: Array<() => void> = [];

// Panel bbox provider — used by the layout-editor + drag-preview modal
// to render this panel's proxy at the right place. Returns the
// user-dragged offset-adjusted top-left rectangle, even when the
// popover isn't open.
registerPanelBbox(PANEL_IDS.musicBoard, async () => {
  try {
    let vw = 0;
    try { vw = await OBR.viewport.getWidth(); } catch {}
    vw = Math.max(vw || 0, window.innerWidth || 0, 1024);
    const isPlayer = myRole === "PLAYER";
    const w = POPOVER_W;
    const h = isPlayer ? POPOVER_H_PLYR : POPOVER_H_GM;
    const userOff = getPanelOffset(PANEL_IDS.musicBoard);
    return {
      left: vw - w - RIGHT_INSET + userOff.dx,
      top:  TOP_INSET + userOff.dy,
      width: w,
      height: h,
    };
  } catch { return null; }
});

export async function setupMusicBoard(): Promise<void> {
  try { myRole = (await OBR.player.getRole()) as "GM" | "PLAYER"; } catch {}

  // GM-only: react to the cluster-row toggle button.
  if (myRole === "GM") {
    try {
      const u = OBR.broadcast.onMessage(BC_TOGGLE, () => { void toggleRoomOpen(); });
      if (typeof u === "function") unsubs.push(u);
    } catch (e) {
      console.warn("[music-board] subscribe toggle failed", e);
    }
  }

  // EVERY client reacts to scene-metadata `open` flag.
  try { await OBR.scene.isReady(); } catch {}
  try {
    const meta = await OBR.scene.getMetadata().catch(() => ({} as any));
    const init = meta[META_KEY_OPEN] as any;
    await reactToOpenFlag(!!init?.open);
  } catch (e) {
    console.warn("[music-board] initial metadata read failed", e);
  }
  try {
    const u = OBR.scene.onMetadataChange((meta) => {
      const cur = meta[META_KEY_OPEN] as any;
      void reactToOpenFlag(!!cur?.open);
    });
    if (typeof u === "function") unsubs.push(u);
  } catch (e) {
    console.warn("[music-board] subscribe scene metadata failed", e);
  }

  // Drag-end → re-open at the new offset. The drag-preview modal
  // saved the new dx/dy in localStorage; openPopover re-reads it.
  try {
    const u = OBR.broadcast.onMessage(BC_PANEL_DRAG_END, async (event) => {
      const data = event.data as DragEndPayload | undefined;
      if (data?.panelId !== PANEL_IDS.musicBoard) return;
      if (popoverOpen) {
        await closePopover();
        await openPopover();
      }
    });
    if (typeof u === "function") unsubs.push(u);
  } catch {}
  try {
    const u = OBR.broadcast.onMessage(BC_PANEL_RESET, async () => {
      if (popoverOpen) {
        await closePopover();
        await openPopover();
      }
    });
    if (typeof u === "function") unsubs.push(u);
  } catch {}

  console.info("[music-board] module setup complete; role =", myRole);
}

async function toggleRoomOpen(): Promise<void> {
  if (myRole !== "GM") return;
  try {
    const meta = await OBR.scene.getMetadata();
    const cur = (meta[META_KEY_OPEN] as any) || {};
    const newOpen = !cur.open;
    const patch: Record<string, unknown> = {
      [META_KEY_OPEN]: { open: newOpen, ts: Date.now() },
    };
    // Going from closed → open: blank the music-state metadata too,
    // so old BGM / SFX entries from a previous pairing session don't
    // get replayed by every popover that just opened.
    if (newOpen) {
      patch[META_KEY_STATE] = {
        bgm: null,
        sfx: [],
        bus: { bgm: 0.8, sfx: 1.0 },
        ts: Date.now(),
      };
    }
    await OBR.scene.setMetadata(patch);
  } catch (e) {
    console.warn("[music-board] toggle failed", e);
  }
}

async function reactToOpenFlag(shouldBeOpen: boolean): Promise<void> {
  try {
    OBR.broadcast.sendMessage(BC_ACTIVE, { open: shouldBeOpen },
      { destination: "LOCAL" });
  } catch {}
  if (shouldBeOpen && !popoverOpen) {
    await openPopover();
  } else if (!shouldBeOpen && popoverOpen) {
    await closePopover();
  }
}

async function openPopover(): Promise<void> {
  if (popoverOpen) return;
  let vw = 0, vh = 0;
  try { vw = await OBR.viewport.getWidth(); } catch {}
  try { vh = await OBR.viewport.getHeight(); } catch {}
  vw = Math.max(vw || 0, window.innerWidth || 0, 1024);
  vh = Math.max(vh || 0, window.innerHeight || 0, 720);
  const isPlayer = myRole === "PLAYER";
  const targetH  = isPlayer ? POPOVER_H_PLYR : POPOVER_H_GM;
  const userOff  = getPanelOffset(PANEL_IDS.musicBoard);
  // Players boot minimized so the music board doesn't slam over their UI.
  const url = `${PAGE_URL}?role=${myRole}${isPlayer ? "&mini=1" : ""}`;
  try {
    await OBR.popover.open({
      id: POPOVER_ID,
      url,
      width: POPOVER_W,
      height: Math.min(targetH, vh - 80),
      anchorReference: "POSITION",
      // Anchor at viewport right - RIGHT_INSET, shifted by user drag.
      // transformOrigin RIGHT keeps the popover's right edge pinned
      // (so dragging dx>0 moves it right, dx<0 moves it left).
      anchorPosition: {
        left: vw - RIGHT_INSET + userOff.dx,
        top:  TOP_INSET        + userOff.dy,
      },
      anchorOrigin:    { horizontal: "RIGHT", vertical: "TOP" },
      transformOrigin: { horizontal: "RIGHT", vertical: "TOP" },
      hidePaper: true,
      disableClickAway: true,
    });
    popoverOpen = true;
  } catch (e) {
    console.warn("[music-board] popover.open failed", e);
  }
}

async function closePopover(): Promise<void> {
  if (!popoverOpen) return;
  try { await OBR.popover.close(POPOVER_ID); } catch {}
  popoverOpen = false;
}

export function teardownMusicBoard(): void {
  for (const u of unsubs.splice(0)) { try { u(); } catch {} }
  if (popoverOpen) {
    void OBR.popover.close(POPOVER_ID).catch(() => {});
    popoverOpen = false;
  }
}
