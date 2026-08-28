import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { to3mf } from "@/lib/threeMfExport";

describe("to3mf", () => {
  it("builds a Core 3MF ZIP with content types, rels, and a triangle mesh", () => {
    const bytes = to3mf([
      {
        name: "Triangle",
        vertices: [
          [0, 0, 0],
          [10, 0, 0],
          [0, 5, 0],
        ],
        faces: [[0, 1, 2]],
      },
    ]);

    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"].sort());

    const modelXml = strFromU8(files["3D/3dmodel.model"]);
    expect(modelXml).toContain('unit="millimeter"');
    expect(modelXml).toContain("<vertex ");
    expect(modelXml).toContain('<triangle v1="0" v2="1" v3="2"');
    // Y-up (0,5,0) → Z-up (0,0,5)
    expect(modelXml).toContain('x="0" y="0" z="5"');
  });

  it("rejects empty mesh lists", () => {
    expect(() => to3mf([])).toThrow(/No triangle geometry/);
  });
});
