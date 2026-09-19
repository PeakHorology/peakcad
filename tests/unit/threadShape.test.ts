import { describe, expect, it } from "vitest";
import { createThreadShape } from "@/lib/threadShape";
import { findMetricThread } from "@/lib/metricThreads";

function threadBase(threadSpec?: { designation: string; majorDiameter: number; pitch: number }) {
  return {
    id: "thread-1",
    name: "Threads M6",
    color: "#d97813",
    height: 20,
    ...(threadSpec ? { threadSpec } : {}),
  } as Parameters<typeof createThreadShape>[0]["base"];
}

describe("threadShape", () => {
  it("takes diameter and pitch from the designation, not from the previous spec", () => {
    const m8 = findMetricThread("M8")!;

    // What the editor forwards after a size-driven re-designation: the new designation
    // alongside the outgoing M6 measurements.
    const resized = createThreadShape({
      designation: "M8",
      base: threadBase({ designation: "M8", majorDiameter: 6, pitch: 1 }),
    });

    expect(resized.threadSpec?.designation).toBe("M8");
    expect(resized.threadSpec?.majorDiameter).toBeCloseTo(m8.majorDiameter, 6);
    expect(resized.threadSpec?.pitch).toBeCloseTo(m8.pitch, 6);
  });

  it("actually builds a wider screw when the designation grows", () => {
    const asM6 = createThreadShape({ designation: "M6", base: threadBase() });
    const asM8 = createThreadShape({
      designation: "M8",
      base: threadBase({ designation: "M8", majorDiameter: 6, pitch: 1 }),
    });

    // The label used to change while the solid kept its 6mm major diameter.
    expect(asM8.width).toBeGreaterThan(asM6.width + 1);
  });
});
