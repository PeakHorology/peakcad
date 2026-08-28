/** Cursor radius, in pixels, inside which an edge overlay counts as pointed at. */
export const MODIFIER_EDGE_PICK_RADIUS_PX = 14;

/**
 * Cursor-distance slack, in pixels, within which the edge nearer the camera wins the pick.
 *
 * Edge overlays draw with depth testing off, so an edge on the far side of the part is as visible
 * as the one in front of it and just as pickable. On a plate seen at a shallow angle the bottom rim
 * projects a pixel or two from the top rim, and ranking on cursor distance alone handed the hover
 * to whichever happened to land closer — often the hidden one — so the edge under the pointer
 * refused to light up.
 */
export const MODIFIER_EDGE_DEPTH_SLACK_PX = 6;

export type ModifierEdgeCandidate = {
  id: number;
  /** Pixels from the cursor to the edge's nearest point on screen. */
  distance: number;
  /** Normalised device depth at that point; smaller is nearer the camera. */
  depth: number;
};

/** Nearest point on a screen-space segment, as a distance and a position along it. */
export function closestPointOnScreenSegment(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { distance: number; amount: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const raw = lengthSq > 0.0001 ? ((x - ax) * dx + (y - ay) * dy) / lengthSq : 0;
  const amount = Math.min(1, Math.max(0, raw));
  return { distance: Math.hypot(x - (ax + dx * amount), y - (ay + dy * amount)), amount };
}

/**
 * Pick one edge from everything under the cursor.
 *
 * Inside the slack band two edges are equally "under" the pointer, so the one facing the camera
 * wins; outside it the pointer is clearly aimed at one of them and distance decides.
 */
export function chooseModifierEdgeCandidate(candidates: Iterable<ModifierEdgeCandidate>): number | null {
  let best: ModifierEdgeCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.distance >= MODIFIER_EDGE_PICK_RADIUS_PX) continue;
    if (!best) {
      best = candidate;
      continue;
    }
    const tied = Math.abs(candidate.distance - best.distance) <= MODIFIER_EDGE_DEPTH_SLACK_PX;
    if (tied ? candidate.depth < best.depth : candidate.distance < best.distance) best = candidate;
  }
  return best?.id ?? null;
}
