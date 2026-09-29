import { sceneShape } from "@/lib/shapeCatalog";
import type { WorkplaneShape } from "@/types/sketchforge";

export function makeHouseScene(): WorkplaneShape[] {
  return [
    sceneShape({ name: "Grass base", kind: "box", color: "#4f9b58", x: 0, z: 0, width: 118, depth: 92, height: 1 }),
    sceneShape({ name: "House body", kind: "box", color: "#e7c49a", x: 0, z: 2, width: 52, depth: 42, height: 34, elevation: 1 }),
    sceneShape({ name: "Gable roof", kind: "roof", color: "#a83c32", x: 0, z: 2, width: 66, depth: 54, height: 23, elevation: 35 }),
    sceneShape({ name: "Chimney", kind: "box", color: "#7f3328", x: 17, z: -9, width: 8, depth: 8, height: 18, elevation: 45 }),
    sceneShape({ name: "Front door", kind: "box", color: "#6d4427", x: 0, z: -20.4, width: 12, depth: 1.4, height: 19, elevation: 1.5 }),
    sceneShape({ name: "Door knob", kind: "sphere", color: "#e0b23f", x: 4.2, z: -21.6, width: 2.2, depth: 2.2, height: 2.2, elevation: 11 }),
    sceneShape({ name: "Left front window", kind: "box", color: "#6fc8e8", x: -16, z: -20.7, width: 10, depth: 1.2, height: 8, elevation: 18 }),
    sceneShape({ name: "Right front window", kind: "box", color: "#6fc8e8", x: 16, z: -20.7, width: 10, depth: 1.2, height: 8, elevation: 18 }),
    sceneShape({ name: "Left side window", kind: "box", color: "#6fc8e8", x: -26.2, z: 8, width: 10, depth: 1.2, height: 8, elevation: 18, rotation: 90 }),
    sceneShape({ name: "Right side window", kind: "box", color: "#6fc8e8", x: 26.2, z: 8, width: 10, depth: 1.2, height: 8, elevation: 18, rotation: 90 }),
    sceneShape({ name: "Porch step", kind: "box", color: "#9d9b91", x: 0, z: -28, width: 24, depth: 10, height: 2, elevation: 1 }),
    sceneShape({ name: "Walkway", kind: "box", color: "#b8b4a8", x: 0, z: -50, width: 12, depth: 36, height: 0.8, elevation: 0.2 }),
    sceneShape({ name: "Tree trunk", kind: "cylinder", color: "#7b4a2b", x: -42, z: 22, width: 7, depth: 7, height: 18, elevation: 1, sides: 18 }),
    sceneShape({ name: "Tree crown", kind: "sphere", color: "#2f8e45", x: -42, z: 22, width: 24, depth: 24, height: 22, elevation: 18 }),
    sceneShape({ name: "Mailbox post", kind: "box", color: "#5a4b3d", x: 32, z: -42, width: 3, depth: 3, height: 12, elevation: 1 }),
    sceneShape({ name: "Mailbox", kind: "roundRoof", color: "#2e6ca8", x: 32, z: -42, width: 13, depth: 8, height: 7, elevation: 13, rotation: 90 }),
  ];
}

export function makeBlockPerfScene(count = 500): WorkplaneShape[] {
  const safeCount = Math.max(1, Math.min(5000, Math.floor(count)));
  const columns = Math.ceil(Math.sqrt(safeCount));
  const spacing = 7;
  const offset = ((columns - 1) * spacing) / 2;
  const colors = ["#d41721", "#d97813", "#f2cf10", "#33983d", "#0098c7", "#294c93"];

  return Array.from({ length: safeCount }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return sceneShape({
      id: `perf-block-${index + 1}`,
      name: `Perf block ${index + 1}`,
      kind: "box",
      color: colors[index % colors.length],
      x: column * spacing - offset,
      z: row * spacing - offset,
      width: 5,
      depth: 5,
      height: 5,
    });
  });
}
