import { describe, expect, it } from "vitest";
import { closedProfilesFromLegacy, orderedSketchPaths } from "@/lib/sketch/profiles";
import type { SketchProfile } from "@/types/sketchforge";

type Pt = SketchProfile["points"][number];

function profile(points: Pt[], segments: [string, string, string][]): SketchProfile {
  return {
    points,
    segments: segments.map(([id, startId, endId]) => ({ id, startId, endId, kind: "line" as const })),
  };
}

const SQUARE_POINTS: Pt[] = [
  { id: "p1", x: 0, z: 0 },
  { id: "p2", x: 10, z: 0 },
  { id: "p3", x: 10, z: 10 },
  { id: "p4", x: 0, z: 10 },
];

const SQUARE_SEGMENTS: [string, string, string][] = [
  ["s1", "p1", "p2"],
  ["s2", "p2", "p3"],
  ["s3", "p3", "p4"],
  ["s4", "p4", "p1"],
];

describe("orderedSketchPaths", () => {
  it("closes a clean square", () => {
    const paths = orderedSketchPaths(profile(SQUARE_POINTS, SQUARE_SEGMENTS));
    expect(paths).toHaveLength(1);
    expect(paths[0].closed).toBe(true);
    expect(paths[0].points.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(paths[0].steps).toHaveLength(4);
  });

  it("still finds the loop when a stray segment hangs off a corner", () => {
    // The walk starts at the dangling end, so the return to p1 is not a return to the start
    // point. That reported the whole component as one open path, leaving the sketch with no
    // profile at all — the square could not be extruded because of one leftover line.
    const paths = orderedSketchPaths(
      profile(
        [...SQUARE_POINTS, { id: "p5", x: -8, z: 0 }],
        [...SQUARE_SEGMENTS, ["s5", "p1", "p5"]],
      ),
    );

    const closed = paths.filter((path) => path.closed);
    expect(closed).toHaveLength(1);
    expect(closed[0].steps).toHaveLength(4);
    expect(new Set(closed[0].points.map((p) => p.id))).toEqual(new Set(["p1", "p2", "p3", "p4"]));

    // The tail survives as its own open path rather than being swallowed or dropped.
    const open = paths.filter((path) => !path.closed);
    expect(open).toHaveLength(1);
    expect(open[0].steps.map((step) => step.segment.id)).toEqual(["s5"]);
  });

  it("finds the loop when the stray segment is attached mid-edge", () => {
    const paths = orderedSketchPaths(
      profile(
        [...SQUARE_POINTS, { id: "p5", x: 18, z: 10 }],
        [...SQUARE_SEGMENTS, ["s5", "p3", "p5"]],
      ),
    );
    expect(paths.filter((path) => path.closed)).toHaveLength(1);
  });

  it("leaves an open polyline open", () => {
    const paths = orderedSketchPaths(
      profile(SQUARE_POINTS, [["s1", "p1", "p2"], ["s2", "p2", "p3"]]),
    );
    expect(paths).toHaveLength(1);
    expect(paths[0].closed).toBe(false);
    // Either end may be chosen as the start, so only require a contiguous traversal.
    const ids = paths[0].points.map((p) => p.id);
    expect([["p1", "p2", "p3"], ["p3", "p2", "p1"]]).toContainEqual(ids);
  });

  it("separates two disconnected squares", () => {
    const second: Pt[] = [
      { id: "q1", x: 40, z: 0 },
      { id: "q2", x: 50, z: 0 },
      { id: "q3", x: 50, z: 10 },
      { id: "q4", x: 40, z: 10 },
    ];
    const paths = orderedSketchPaths(
      profile([...SQUARE_POINTS, ...second], [
        ...SQUARE_SEGMENTS,
        ["t1", "q1", "q2"],
        ["t2", "q2", "q3"],
        ["t3", "q3", "q4"],
        ["t4", "q4", "q1"],
      ]),
    );
    expect(paths.filter((path) => path.closed)).toHaveLength(2);
  });

  it("finds both loops of a figure eight sharing one vertex", () => {
    const paths = orderedSketchPaths(
      profile(
        [
          ...SQUARE_POINTS,
          { id: "p6", x: -10, z: 0 },
          { id: "p7", x: -10, z: -10 },
          { id: "p8", x: 0, z: -10 },
        ],
        [
          ...SQUARE_SEGMENTS,
          ["s5", "p1", "p6"],
          ["s6", "p6", "p7"],
          ["s7", "p7", "p8"],
          ["s8", "p8", "p1"],
        ],
      ),
    );
    expect(paths.filter((path) => path.closed)).toHaveLength(2);
  });

  it("ignores segments referencing missing points", () => {
    const paths = orderedSketchPaths(
      profile(SQUARE_POINTS, [...SQUARE_SEGMENTS, ["bad", "p1", "nope"]]),
    );
    expect(paths.filter((path) => path.closed)).toHaveLength(1);
  });
});

/** Concentric axis-aligned square loop, centred on the origin. */
function ring(prefix: string, half: number): { points: Pt[]; segments: [string, string, string][] } {
  const points: Pt[] = [
    { id: `${prefix}1`, x: -half, z: -half },
    { id: `${prefix}2`, x: half, z: -half },
    { id: `${prefix}3`, x: half, z: half },
    { id: `${prefix}4`, x: -half, z: half },
  ];
  return {
    points,
    segments: [
      [`${prefix}s1`, `${prefix}1`, `${prefix}2`],
      [`${prefix}s2`, `${prefix}2`, `${prefix}3`],
      [`${prefix}s3`, `${prefix}3`, `${prefix}4`],
      [`${prefix}s4`, `${prefix}4`, `${prefix}1`],
    ],
  };
}

describe("closedProfilesFromLegacy", () => {
  it("treats a plate with one hole as a single profile", () => {
    const outer = ring("o", 20);
    const hole = ring("h", 8);
    const profiles = closedProfilesFromLegacy(
      profile([...outer.points, ...hole.points], [...outer.segments, ...hole.segments]),
    );
    expect(profiles).toHaveLength(1);
    expect(profiles[0].holePointIdLoops).toHaveLength(1);
  });

  it("keeps a solid island inside a hole as its own profile", () => {
    // A post standing in a bore. Claiming every smaller contained loop as a hole of the outermost
    // one recorded the island as a second hole, and cutting already-void space erased it.
    const outer = ring("o", 20);
    const bore = ring("h", 12);
    const island = ring("i", 4);
    const profiles = closedProfilesFromLegacy(
      profile(
        [...outer.points, ...bore.points, ...island.points],
        [...outer.segments, ...bore.segments, ...island.segments],
      ),
    );

    expect(profiles).toHaveLength(2);
    const plate = profiles.find((p) => p.area > 1000);
    const post = profiles.find((p) => p.area < 100);
    expect(plate?.holePointIdLoops).toHaveLength(1);
    expect(plate?.holePointIdLoops[0]).toEqual(bore.points.map((p) => p.id));
    expect(post?.holePointIdLoops).toHaveLength(0);
  });

  it("gives each of two separate plates its own hole", () => {
    const shift = (pts: Pt[], dx: number) => pts.map((p) => ({ ...p, x: p.x + dx }));
    const a = ring("a", 10);
    const aHole = ring("b", 4);
    const c = ring("c", 10);
    const cHole = ring("d", 4);
    const profiles = closedProfilesFromLegacy(
      profile(
        [...a.points, ...aHole.points, ...shift(c.points, 60), ...shift(cHole.points, 60)],
        [...a.segments, ...aHole.segments, ...c.segments, ...cHole.segments],
      ),
    );
    expect(profiles).toHaveLength(2);
    expect(profiles[0].holePointIdLoops).toHaveLength(1);
    expect(profiles[1].holePointIdLoops).toHaveLength(1);
  });

  it("measures a bezier circle as a circle, not as its inscribed square", () => {
    // Four-anchor circle of radius 20. Using the anchors alone gave 800mm² instead of ~1257mm².
    const r = 20;
    const k = (4 / 3) * Math.tan(Math.PI / 8) * r;
    const points: Pt[] = [
      { id: "c1", x: r, z: 0, mode: "smooth", handleIn: { x: r, z: -k }, handleOut: { x: r, z: k } },
      { id: "c2", x: 0, z: r, mode: "smooth", handleIn: { x: k, z: r }, handleOut: { x: -k, z: r } },
      { id: "c3", x: -r, z: 0, mode: "smooth", handleIn: { x: -r, z: k }, handleOut: { x: -r, z: -k } },
      { id: "c4", x: 0, z: -r, mode: "smooth", handleIn: { x: -k, z: -r }, handleOut: { x: k, z: -r } },
    ];
    const ids = ["c1", "c2", "c3", "c4"];
    const segments = ids.map((id, index) => [`cs${index}`, id, ids[(index + 1) % ids.length]] as [string, string, string]);
    const doc: SketchProfile = {
      points,
      segments: segments.map(([id, startId, endId]) => ({ id, startId, endId, kind: "bezier" as const })),
    };

    const [profile] = closedProfilesFromLegacy(doc);
    const trueArea = Math.PI * r * r;
    // Sampling inscribes the curve, so it lands a fraction under rather than 36% under.
    expect(profile.area / trueArea).toBeGreaterThan(0.995);
    expect(profile.area).toBeLessThanOrEqual(trueArea);
  });

  it("keeps a hole near a curved boundary inside its circle", () => {
    // The hole sits outside the anchors' inscribed square but well inside the real circle, so the
    // unsampled outline used to report it as a separate profile rather than a hole.
    const r = 30;
    const k = (4 / 3) * Math.tan(Math.PI / 8) * r;
    const circle: Pt[] = [
      { id: "c1", x: r, z: 0, mode: "smooth", handleIn: { x: r, z: -k }, handleOut: { x: r, z: k } },
      { id: "c2", x: 0, z: r, mode: "smooth", handleIn: { x: k, z: r }, handleOut: { x: -k, z: r } },
      { id: "c3", x: -r, z: 0, mode: "smooth", handleIn: { x: -r, z: k }, handleOut: { x: -r, z: -k } },
      { id: "c4", x: 0, z: -r, mode: "smooth", handleIn: { x: -k, z: -r }, handleOut: { x: k, z: -r } },
    ];
    const ids = ["c1", "c2", "c3", "c4"];
    const hole = ring("h", 3);
    const holeAt = hole.points.map((p) => ({ ...p, x: p.x + 20, z: p.z + 12 }));

    const profiles = closedProfilesFromLegacy({
      points: [...circle, ...holeAt],
      segments: [
        ...ids.map((id, index) => ({
          id: `cs${index}`,
          startId: id,
          endId: ids[(index + 1) % ids.length],
          kind: "bezier" as const,
        })),
        ...hole.segments.map(([id, startId, endId]) => ({ id, startId, endId })),
      ],
    });

    expect(profiles).toHaveLength(1);
    expect(profiles[0].holePointIdLoops).toHaveLength(1);
  });

  it("assigns a hole to the innermost loop that contains it", () => {
    const outer = ring("o", 40);
    const middle = ring("m", 30);
    const inner = ring("i", 20);
    const deepest = ring("d", 10);
    const profiles = closedProfilesFromLegacy(
      profile(
        [...outer.points, ...middle.points, ...inner.points, ...deepest.points],
        [...outer.segments, ...middle.segments, ...inner.segments, ...deepest.segments],
      ),
    );
    // Depths 0/1/2/3 → two material rings, each carrying the void immediately inside it.
    expect(profiles).toHaveLength(2);
    expect(profiles[0].holePointIdLoops[0]).toEqual(middle.points.map((p) => p.id));
    expect(profiles[1].holePointIdLoops[0]).toEqual(deepest.points.map((p) => p.id));
  });
});
