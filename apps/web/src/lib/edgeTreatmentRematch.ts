/** Geometric edge fingerprints so fillet/chamfer recipes survive remesh ID churn. */

export type EdgeTreatmentFingerprint = {
  mid: [number, number, number];
  length: number;
  angle: number;
  /**
   * Arc-length weighted centroid. `mid` is only the chord midpoint of the polyline's
   * endpoints, which collapses to an arbitrary point on the curve for a closed edge —
   * a cylinder rim fingerprints to wherever the tessellation seam happens to fall, so a
   * re-seamed rim can score further from itself than the opposite rim does. The centroid
   * is independent of both the seam and the tessellation density.
   * Optional: recipes saved before this field existed carry `mid` only.
   */
  centroid?: [number, number, number];
  /** Unit chord direction, sign-canonicalized so vertex order cannot flip it. */
  direction?: [number, number, number];
};

type FingerprintableEdge = {
  id: number;
  points: number[];
  angle: number;
  selectable?: boolean;
};

type RecipeLike = {
  edgeCount: number;
  edgeIds?: number[];
  edgeFingerprints?: EdgeTreatmentFingerprint[];
  allEdges?: boolean;
};

/** Sign-canonicalized unit vector, so a reversed vertex order fingerprints the same. */
function canonicalDirection(dx: number, dy: number, dz: number): [number, number, number] | undefined {
  const magnitude = Math.hypot(dx, dy, dz);
  if (!(magnitude > 1e-9)) {
    return undefined;
  }
  let x = dx / magnitude;
  let y = dy / magnitude;
  let z = dz / magnitude;
  const dominant = Math.abs(x) >= Math.abs(y) && Math.abs(x) >= Math.abs(z) ? x : Math.abs(y) >= Math.abs(z) ? y : z;
  if (dominant < 0) {
    x = -x;
    y = -y;
    z = -z;
  }
  return [x, y, z];
}

/** Centroid, arc length, chord midpoint and direction for an OCCT edge polyline. */
export function fingerprintCadEdge(edge: { points: number[]; angle: number }): EdgeTreatmentFingerprint | null {
  if (edge.points.length < 6) {
    return null;
  }
  let arcLength = 0;
  let weightedX = 0;
  let weightedY = 0;
  let weightedZ = 0;
  for (let i = 3; i + 2 < edge.points.length; i += 3) {
    const segment = Math.hypot(
      edge.points[i] - edge.points[i - 3],
      edge.points[i + 1] - edge.points[i - 2],
      edge.points[i + 2] - edge.points[i - 1],
    );
    if (!(segment > 0)) {
      continue;
    }
    arcLength += segment;
    weightedX += ((edge.points[i] + edge.points[i - 3]) / 2) * segment;
    weightedY += ((edge.points[i + 1] + edge.points[i - 2]) / 2) * segment;
    weightedZ += ((edge.points[i + 2] + edge.points[i - 1]) / 2) * segment;
  }
  const ax = edge.points[0];
  const ay = edge.points[1];
  const az = edge.points[2];
  const bx = edge.points[edge.points.length - 3];
  const by = edge.points[edge.points.length - 2];
  const bz = edge.points[edge.points.length - 1];
  const chord = Math.hypot(bx - ax, by - ay, bz - az);
  const length = arcLength > 1e-6 ? arcLength : chord;
  if (!(length > 1e-6)) {
    return null;
  }
  const mid: [number, number, number] = [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2];
  const centroid: [number, number, number] = arcLength > 1e-6
    ? [weightedX / arcLength, weightedY / arcLength, weightedZ / arcLength]
    : mid;
  const direction = canonicalDirection(bx - ax, by - ay, bz - az);
  return {
    mid,
    length,
    angle: edge.angle,
    centroid,
    ...(direction ? { direction } : {}),
  };
}

export function fingerprintsForEdgeIds(
  edges: FingerprintableEdge[],
  edgeIds: number[],
): EdgeTreatmentFingerprint[] {
  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  const out: EdgeTreatmentFingerprint[] = [];
  for (const id of edgeIds) {
    const edge = byId.get(id);
    if (!edge) continue;
    const fingerprint = fingerprintCadEdge(edge);
    if (fingerprint) out.push(fingerprint);
  }
  return out;
}

/** Score 0 = identical edge; higher is a worse match. */
function fingerprintDistance(a: EdgeTreatmentFingerprint, b: EdgeTreatmentFingerprint) {
  // Compare centroids when both sides have them; legacy recipes only carry chord midpoints.
  const comparable = a.centroid && b.centroid;
  const pa = comparable ? a.centroid! : a.mid;
  const pb = comparable ? b.centroid! : b.mid;
  const positionDist = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
  const lengthScale = Math.max(1, (a.length + b.length) / 2);
  const lengthRatio = Math.abs(a.length - b.length) / lengthScale;
  const angleDelta = Math.abs(a.angle - b.angle) / 180;
  let directionPenalty = 0;
  if (a.direction && b.direction) {
    const alignment = Math.abs(
      a.direction[0] * b.direction[0] + a.direction[1] * b.direction[1] + a.direction[2] * b.direction[2],
    );
    directionPenalty = (1 - Math.min(1, alignment)) * 0.6;
  }
  return positionDist / lengthScale + lengthRatio * 0.35 + angleDelta * 0.25 + directionPenalty;
}

/**
 * Score ceiling for accepting a match. Deliberately conservative: no match falls through to
 * a visible "could not auto re-apply — use Edge tools again", whereas a loose match silently
 * puts the fillet on the wrong edge and ships a wrong part.
 */
const MATCH_SCORE_LIMIT = 0.35;

/**
 * A winner must be clearly better than the runner-up. On a symmetric body several edges are
 * geometrically interchangeable, and picking one by a hair is a coin flip, not a match.
 */
function beatsRunnerUp(best: number, runnerUp: number | null) {
  if (runnerUp == null) {
    return true;
  }
  return best * 2 <= runnerUp || runnerUp - best >= 0.05;
}

/**
 * Resolve live edge IDs for a stored recipe.
 * Prefer geometric fingerprints, then exact ID reuse, then top-N-by-angle fallback.
 */
export function matchRecipeEdgeIds(
  recipe: RecipeLike,
  edges: FingerprintableEdge[],
  sharpAngle: number,
): number[] {
  const selectable = edges.filter(
    (edge) => edge.selectable !== false && edge.angle + 1e-3 >= sharpAngle && edge.points.length >= 6,
  );
  if (selectable.length === 0) {
    return [];
  }
  if (recipe.allEdges || !recipe.edgeCount) {
    return selectable.map((edge) => edge.id);
  }

  const fingerprints = recipe.edgeFingerprints ?? [];
  if (fingerprints.length > 0) {
    const used = new Set<number>();
    const matched: number[] = [];
    for (const target of fingerprints) {
      let best: { id: number; score: number } | null = null;
      let runnerUp: number | null = null;
      for (const edge of selectable) {
        if (used.has(edge.id)) continue;
        const live = fingerprintCadEdge(edge);
        if (!live) continue;
        const score = fingerprintDistance(target, live);
        if (!best || score < best.score) {
          runnerUp = best?.score ?? runnerUp;
          best = { id: edge.id, score };
        } else if (runnerUp == null || score < runnerUp) {
          runnerUp = score;
        }
      }
      if (best && best.score <= MATCH_SCORE_LIMIT && beatsRunnerUp(best.score, runnerUp)) {
        used.add(best.id);
        matched.push(best.id);
      }
    }
    if (matched.length > 0) {
      return matched;
    }
    // Fingerprints exist but nothing matched: the topology really changed. Report that
    // instead of falling through to "sharpest N", which fillets arbitrary edges.
    return [];
  }

  if (recipe.edgeIds?.length) {
    const liveIds = new Set(selectable.map((edge) => edge.id));
    const kept = recipe.edgeIds.filter((id) => liveIds.has(id));
    if (kept.length === recipe.edgeIds.length) {
      return kept;
    }
  }

  return [...selectable]
    .sort((a, b) => b.angle - a.angle)
    .slice(0, Math.max(1, recipe.edgeCount))
    .map((edge) => edge.id);
}
