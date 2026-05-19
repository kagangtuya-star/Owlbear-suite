/* Music board module — registers the OBR action button that opens
 * the music-board popover. Page content lives in music-board.html /
 * src/music-board-page.ts; this module only sets up entry points.
 *
 * Dev-only (gated in background.ts via STABLE_HIDES). When the
 * studio web tool's PeerJS pairing is mature + we curate a default
 * catalog, we promote to stable.
 */

import OBR from "@owlbear-rodeo/sdk";
import { assetUrl } from "../../asset-base";

const ACTION_ID  = "com.obr-suite/music-board";
const POPOVER_ID = "com.obr-suite/music-board/popover";
const ICON_URL   = assetUrl("music-board-icon.svg");
const PAGE_URL   = assetUrl("music-board.html");

const POPOVER_W = 380;
const POPOVER_H = 540;

let unsubs: Array<() => void> = [];

export async function setupMusicBoard(): Promise<void> {
  // Scene-tool button in the left sidebar — anyone with the plugin
  // sees it (players need to open the listener UI on their side
  // without GM intervention so they actually hear the audio).
  try {
    await OBR.tool.create({
      id: ACTION_ID,
      icons: [{ icon: ICON_URL, label: "音乐板 (听)" }],
      onClick: () => {
        void openPopover();
        return false; // don't switch to this tool, just open the popover
      },
    });
  } catch (e) {
    console.warn("[music-board] tool.create failed", e);
  }
}

let popoverOpen = false;

async function openPopover(): Promise<void> {
  if (popoverOpen) {
    // Toggle close on second click.
    try { await OBR.popover.close(POPOVER_ID); } catch {}
    popoverOpen = false;
    return;
  }
  let vw = 1280, vh = 720;
  try { vw = await OBR.viewport.getWidth(); } catch {}
  try { vh = await OBR.viewport.getHeight(); } catch {}
  const left = Math.max(8, vw - POPOVER_W - 12);
  const top  = 56; // below the top bar
  try {
    await OBR.popover.open({
      id: POPOVER_ID,
      url: PAGE_URL,
      width: POPOVER_W,
      height: Math.min(POPOVER_H, vh - 80),
      anchorReference: "POSITION",
      anchorPosition: { left, top },
      anchorOrigin:    { horizontal: "LEFT", vertical: "TOP" },
      transformOrigin: { horizontal: "LEFT", vertical: "TOP" },
      hidePaper: true,
      disableClickAway: true,
    });
    popoverOpen = true;
  } catch (e) {
    console.warn("[music-board] popover.open failed", e);
  }
}

export function teardownMusicBoard(): void {
  for (const fn of unsubs.splice(0)) {
    try { fn(); } catch {}
  }
  try { OBR.tool.remove(ACTION_ID); } catch {}
  if (popoverOpen) {
    void OBR.popover.close(POPOVER_ID).catch(() => {});
    popoverOpen = false;
  }
}
