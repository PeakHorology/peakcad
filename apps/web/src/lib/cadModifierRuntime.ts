import { hardwareProfile } from "@/lib/desktopHardware";

export const CAD_MODIFIER_RUNTIME_BASE = "/occt";
export const CAD_MODIFIER_MAX_SHARP_ANGLE = 90;

/** Lazy so importing this module in non-window contexts never forces hardware probing. */
export function cadModifierRequestTimeoutMs() {
  return hardwareProfile().modifierTimeoutMs;
}

/** @deprecated Prefer cadModifierRequestTimeoutMs() — kept for existing call sites. */
export const CAD_MODIFIER_REQUEST_TIMEOUT_MS = 30_000;

export type CadModifierRequestPhase = "prepare" | "preview";

export function edgeModifierSelectionStatus(prepared: boolean, selectedCount: number, availableCount: number) {
  return prepared ? `${selectedCount} of ${availableCount} sharp edges selected` : "Preparing edges\u2026";
}

export function cadModifierTimeoutMessage(phase: CadModifierRequestPhase) {
  if (phase === "preview") {
    return "The edge preview timed out. Cancel the tool and try a Draft quality setting, or simplify the selection.";
  }
  return "Edge preparation timed out. Try Draft quality, fewer edges, or a simpler solid.";
}

/**
 * Shown only when the CAD worker's script/module itself failed to load or crashed
 * (Worker constructor threw, or the worker's `error`/`messageerror` event fired) —
 * i.e. there was never a live worker to talk to. This is distinct from the worker
 * starting fine but its lazily-loaded OCCT runtime files (public/occt) being missing,
 * which surfaces as a normal typed error from inside the worker instead.
 */
export function cadModifierWorkerFailureMessage() {
  return "The CAD worker could not start. Restart PeakCAD and try again. If this keeps happening, reinstall PeakCAD to restore its CAD engine files.";
}
