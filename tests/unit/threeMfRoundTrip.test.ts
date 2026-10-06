import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { importedShapeFrom3mf } from "@/lib/threeMfImport";
import { rewrite3mf } from "@/lib/threeMfPackage";

function packageWith(modelXml: string, extras: Record<string, string> = {}) {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8("<Types></Types>"),
    "3D/3dmodel.model": strToU8(modelXml),
    ...Object.fromEntries(Object.entries(extras).map(([path, text]) => [path, strToU8(text)])),
  };
  const zipped = zipSync(files);
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}

const MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="inch" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">Watch plate</metadata>
  <resources>
    <object id="2" name="Plate" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0" />
          <vertex x="1" y="0" z="0" />
          <vertex x="0" y="1" z="0" />
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2" pid="5" p1="0" />
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="2" transform="1 0 0 0 1 0 0 0 1 10 0 0" />
  </build>
</model>
`;

describe("3mf package round trip", () => {
  it("keeps settings and writes the edited model back into the same package", () => {
    const shape = importedShapeFrom3mf("plate.3mf", packageWith(MODEL, {
      "Metadata/project_settings.config": "nozzle=0.4",
    }));
    expect(shape.source3mf?.unitScale).toBeCloseTo(25.4, 6);
    expect(shape.source3mf?.files.some((file) => file.path === "Metadata/project_settings.config")).toBe(true);

    const moved = { ...shape, x: shape.x + 40 };
    const before = strFromU8(unzipSync(rewrite3mf(moved)!)["3D/3dmodel.model"]);
    const widened = { ...shape, width: shape.width * 2, size: Math.max(shape.width * 2, shape.depth) };
    const bytes = rewrite3mf(widened);
    expect(bytes).toBeTruthy();
    const files = unzipSync(bytes!);
    expect(strFromU8(files["Metadata/project_settings.config"])).toBe("nozzle=0.4");
    expect(strFromU8(files["[Content_Types].xml"])).toBe("<Types></Types>");

    const model = strFromU8(files["3D/3dmodel.model"]);
    expect(model).toContain('unit="inch"');
    expect(model).toContain('name="Title">Watch plate</metadata>');
    expect(model).toContain('transform="1 0 0 0 1 0 0 0 1 10 0 0"');
    expect(model).toContain('pid="5" p1="0"');
    expect(model).not.toContain("PEAKCAD-MESH");
    expect(model).not.toBe(before);

    const xs = [...model.matchAll(/\bx="([^"]+)"/g)].map((match) => Number(match[1]));
    const span = Math.max(...xs) - Math.min(...xs);
    expect(span).toBeCloseTo(2, 4);
  });

  it("does not move the model in the file when it is only moved on the workplane", () => {
    const shape = importedShapeFrom3mf("plate.3mf", packageWith(MODEL));
    const parked = strFromU8(unzipSync(rewrite3mf(shape)!)["3D/3dmodel.model"]);
    const moved = strFromU8(unzipSync(rewrite3mf({ ...shape, x: shape.x + 25, z: shape.z - 10 })!)["3D/3dmodel.model"]);
    expect(moved).toBe(parked);
  });
});
