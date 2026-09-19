import { withCsgMeta } from "@/lib/csgTree";
import { sceneShape } from "@/lib/shapeCatalog";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@/lib/workplaneSettings";
import type { WorkplaneShape } from "@/types/sketchforge";

export const INTRO_PROJECT_ID = "peakcad-intro-block-hole";
export const INTRO_PROJECT_NAME = "Block with a hole";
export const INTRO_SEEDED_STORAGE_KEY = "peakcad:introSeeded";
export const INTRO_COACH_DISMISSED_KEY = "peakcad:introCoachDismissed";

export function isIntroProjectId(projectId: string | null | undefined) {
  return projectId === INTRO_PROJECT_ID;
}

export function hasIntroBeenSeeded() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(INTRO_SEEDED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markIntroSeeded() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(INTRO_SEEDED_STORAGE_KEY, "1");
  } catch {
    // First-run still works in-memory for this session.
  }
}

export function hasIntroCoachBeenDismissed() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(INTRO_COACH_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markIntroCoachDismissed() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(INTRO_COACH_DISMISSED_KEY, "1");
  } catch {
    // Coach stays dismissed for this session.
  }
}

export function createIntroShapes(): WorkplaneShape[] {
  const box = sceneShape({
    id: "intro-box",
    name: "Box",
    kind: "box",
    color: "#d41721",
    x: 0,
    z: 0,
    elevation: 0,
    size: 24,
    width: 24,
    depth: 24,
    height: 16,
  });
  const hole = sceneShape({
    id: "intro-hole",
    name: "Hole",
    kind: "cylinder",
    color: "#d97813",
    hole: true,
    x: 0,
    z: 0,
    elevation: -2,
    size: 10,
    width: 10,
    depth: 10,
    height: 20,
    bevel: 0,
    segments: 1,
  });
  const group = withCsgMeta(
    sceneShape({
      id: "intro-group",
      name: INTRO_PROJECT_NAME,
      kind: "mesh",
      color: "#d41721",
      x: 0,
      z: 0,
      elevation: 0,
      size: 24,
      width: 24,
      depth: 24,
      height: 16,
      groupedBaseWidth: 24,
      groupedBaseDepth: 24,
      groupedBaseHeight: 16,
      groupedShapes: [box, hole],
    }),
    "subtract",
    1,
    true,
  );
  return [group];
}

export function createIntroProjectMeta(now = Date.now()) {
  return {
    id: INTRO_PROJECT_ID,
    name: INTRO_PROJECT_NAME,
    createdAt: now,
    updatedAt: now,
    shapes: 1,
    accent: "cyan" as const,
    revision: now,
    workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID,
    folderId: null,
  };
}
