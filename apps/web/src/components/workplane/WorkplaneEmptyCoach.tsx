"use client";

/** Coaching card shown on an empty canvas to point new users at the next step. */
export function WorkplaneEmptyCoach({ visible }: { visible: boolean }) {
  if (!visible) {
    return null;
  }

  return (
    <div className="workplane-empty-coach">
      <div className="workplane-empty-coach-card">
        <strong>Start modeling</strong>
        <p>Drop a shape from the right to place it on the workplane.</p>
        <p className="workplane-empty-coach-secondary">Or switch to Sketch to draw a profile and extrude it.</p>
      </div>
    </div>
  );
}
