import { describe, expect, it } from "vitest";
import { DEFAULT_VIEW_NUDGE_AXES, viewNudgeDelta, type ViewNudgeAxes } from "@/lib/viewNudge";

describe("viewNudgeDelta", () => {
  it("moves along world cardinals for a default camera (right = +X, up = -Z)", () => {
    expect(viewNudgeDelta(DEFAULT_VIEW_NUDGE_AXES, 1, 0, 1)).toEqual({ deltaX: 1, deltaZ: 0 });
    expect(viewNudgeDelta(DEFAULT_VIEW_NUDGE_AXES, -1, 0, 1)).toEqual({ deltaX: -1, deltaZ: 0 });
    expect(viewNudgeDelta(DEFAULT_VIEW_NUDGE_AXES, 0, 1, 1)).toEqual({ deltaX: 0, deltaZ: -1 });
    expect(viewNudgeDelta(DEFAULT_VIEW_NUDGE_AXES, 0, -1, 1)).toEqual({ deltaX: 0, deltaZ: 1 });
  });

  it("snaps diagonal camera axes to a single grid cardinal (no diagonal drift)", () => {
    // Camera yawed ~30°: right has both X and Z, but X is stronger.
    const axes: ViewNudgeAxes = {
      rightX: Math.cos(Math.PI / 6),
      rightZ: Math.sin(Math.PI / 6),
      upX: -Math.sin(Math.PI / 6),
      upZ: Math.cos(Math.PI / 6),
    };
    expect(viewNudgeDelta(axes, 1, 0, 2)).toEqual({ deltaX: 2, deltaZ: 0 });
    expect(viewNudgeDelta(axes, -1, 0, 2)).toEqual({ deltaX: -2, deltaZ: 0 });
    // Screen-up is dominated by +Z here after the 30° yaw of "forward".
    expect(viewNudgeDelta(axes, 0, 1, 2)).toEqual({ deltaX: 0, deltaZ: 2 });
  });

  it("picks the dominant axis when camera is closer to a diagonal", () => {
    const axes: ViewNudgeAxes = {
      rightX: 0.8,
      rightZ: 0.6,
      upX: -0.6,
      upZ: 0.8,
    };
    expect(viewNudgeDelta(axes, 1, 0, 1)).toEqual({ deltaX: 1, deltaZ: 0 });
    expect(viewNudgeDelta(axes, 0, 1, 1)).toEqual({ deltaX: 0, deltaZ: 1 });
  });
});
