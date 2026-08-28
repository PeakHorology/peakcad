type MeshTransfer = {
  vertices: Float32Array;
  faces: Uint32Array;
};

type ManifoldBooleanRequest = {
  requestId: number;
  op: "subtract" | "union" | "intersect";
  solids: MeshTransfer[];
  cutters?: MeshTransfer[];
};

type ManifoldBooleanResponse =
  | { requestId: number; type: "result"; positions: Float32Array }
  | { requestId: number; type: "error"; message: string };

type ManifoldSolid = {
  status: () => string;
  numTri: () => number;
  getMesh: () => { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array };
  subtract: (other: ManifoldSolid) => ManifoldSolid;
  intersect: (other: ManifoldSolid) => ManifoldSolid;
  delete?: () => void;
};

type ManifoldRuntime = {
  setup: () => void;
  Manifold: {
    ofMesh: (mesh: unknown) => ManifoldSolid;
    union: (parts: ManifoldSolid[]) => ManifoldSolid;
  };
  Mesh: new (data: {
    numProp: number;
    vertProperties: Float32Array;
    triVerts: Uint32Array;
    tolerance?: number;
  }) => {
    merge?: () => void;
    delete?: () => void;
  };
};

const workerScope = globalThis as unknown as DedicatedWorkerGlobalScope;

let runtimePromise: Promise<ManifoldRuntime> | null = null;

async function getRuntime() {
  runtimePromise ??= (async () => {
    // App-root public assets (not the webpack worker chunk URL).
    const scriptUrl = new URL("/manifold.js", workerScope.location.origin).href;
    const module = (await import(/* webpackIgnore: true */ scriptUrl)) as {
      default: (config: { locateFile: (file: string) => string }) => Promise<ManifoldRuntime>;
    };
    const runtime = await module.default({
      locateFile: (file: string) =>
        file.endsWith(".wasm")
          ? new URL("/manifold.wasm", workerScope.location.origin).href
          : new URL(`/${file}`, workerScope.location.origin).href,
    });
    runtime.setup();
    return runtime;
  })().catch((error: unknown) => {
    // Clear the cache so a transient load failure (offline reload, interrupted fetch)
    // doesn't leave every later boolean awaiting the same rejected promise.
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

function dispose(value: { delete?: () => void } | null | undefined) {
  value?.delete?.();
}

function meshFromTransfer(runtime: ManifoldRuntime, mesh: MeshTransfer) {
  // Sketch ExtrudeGeometry cutters arrive as triangle soups (no shared verts).
  // merge() welds them so ofMesh accepts a manifold — without this, Manifold fails
  // and the editor falls back to messy BVH CSG cavities.
  const manifoldMesh = new runtime.Mesh({
    numProp: 3,
    vertProperties: mesh.vertices,
    triVerts: mesh.faces,
    // Sketch cutters are triangle soups after bake; a slightly looser tolerance
    // welds face-transform seams so ofMesh stays manifold.
    tolerance: 0.001,
  });
  (manifoldMesh as { merge?: () => void }).merge?.();
  return manifoldMesh;
}

function solidFromTransfer(runtime: ManifoldRuntime, mesh: MeshTransfer, created: Array<{ delete?: () => void }>) {
  const manifoldMesh = meshFromTransfer(runtime, mesh);
  created.push(manifoldMesh);
  try {
    const solid = runtime.Manifold.ofMesh(manifoldMesh);
    created.push(solid);
    if (solid.status() !== "NoError" || solid.numTri() < 1) {
      return null;
    }
    return solid;
  } catch {
    return null;
  }
}

function unionMeshes(runtime: ManifoldRuntime, meshes: MeshTransfer[], created: Array<{ delete?: () => void }>) {
  const parts: ManifoldSolid[] = [];
  for (const mesh of meshes) {
    const solid = solidFromTransfer(runtime, mesh, created);
    if (!solid) return null;
    parts.push(solid);
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];

  // Pairwise tree union reduces coplanar scars on dense hubs (radial spoke patterns).
  let level = parts;
  while (level.length > 1) {
    const next: ManifoldSolid[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        next.push(level[i]);
        continue;
      }
      const merged = runtime.Manifold.union([level[i], level[i + 1]]);
      created.push(merged);
      if (merged.status() !== "NoError" || merged.numTri() < 1) {
        return null;
      }
      next.push(merged);
    }
    level = next;
  }
  return level[0];
}

function positionsFromSolid(solid: ManifoldSolid) {
  const mesh = solid.getMesh();
  const positions = new Float32Array(mesh.triVerts.length * 3);
  const numProp = mesh.numProp;
  for (let i = 0; i < mesh.triVerts.length; i += 1) {
    const vertexIndex = mesh.triVerts[i];
    const offset = vertexIndex * numProp;
    const out = i * 3;
    positions[out] = mesh.vertProperties[offset];
    positions[out + 1] = mesh.vertProperties[offset + 1];
    positions[out + 2] = mesh.vertProperties[offset + 2];
  }
  return positions;
}

async function runBoolean(request: ManifoldBooleanRequest): Promise<ManifoldBooleanResponse> {
  const created: Array<{ delete?: () => void }> = [];
  try {
    const runtime = await getRuntime();
    const solid = unionMeshes(runtime, request.solids, created);
    if (!solid) {
      return { requestId: request.requestId, type: "error", message: "Could not build solid manifold" };
    }

    let result: ManifoldSolid | null = solid;
    if (request.op === "subtract") {
      const cutter = unionMeshes(runtime, request.cutters ?? [], created);
      if (!cutter) {
        return { requestId: request.requestId, type: "error", message: "Could not build cutter manifold" };
      }
      result = solid.subtract(cutter);
      created.push(result);
    } else if (request.op === "intersect") {
      const other = unionMeshes(runtime, request.cutters ?? [], created);
      if (!other) {
        return { requestId: request.requestId, type: "error", message: "Could not build intersection manifold" };
      }
      result = solid.intersect(other);
      created.push(result);
    } else if (request.op === "union") {
      // solid already unioned
      result = solid;
    }

    if (!result || result.status() !== "NoError" || result.numTri() < 1) {
      return { requestId: request.requestId, type: "error", message: "Boolean produced empty geometry" };
    }

    // Fuse near-coplanar scars (dense radial unions leave hub creases along the seed spoke).
    try {
      const withTolerance = result as ManifoldSolid & {
        simplify?: (tolerance?: number) => ManifoldSolid;
        setTolerance?: (tolerance: number) => ManifoldSolid;
      };
      if (typeof withTolerance.setTolerance === "function") {
        const loosened = withTolerance.setTolerance(0.01);
        if (loosened && loosened !== result) {
          created.push(loosened);
          if (loosened.status() === "NoError" && loosened.numTri() > 0) {
            result = loosened;
          }
        }
      }
      const simplify = (result as ManifoldSolid & { simplify?: (tolerance?: number) => ManifoldSolid }).simplify;
      if (typeof simplify === "function") {
        const simplified = simplify.call(result, 0.01);
        if (simplified && simplified !== result) {
          created.push(simplified);
          if (simplified.status() === "NoError" && simplified.numTri() > 0) {
            result = simplified;
          }
        }
      }
    } catch {
      // Optional API.
    }

    const positions = positionsFromSolid(result);
    return { requestId: request.requestId, type: "result", positions };
  } catch (error) {
    return {
      requestId: request.requestId,
      type: "error",
      message: error instanceof Error ? error.message : "Manifold boolean failed",
    };
  } finally {
    Array.from(new Set(created)).forEach(dispose);
  }
}

/** One boolean at a time — overlapping Manifold WASM ops on a shared runtime are unsafe. */
let booleanQueue: Promise<void> = Promise.resolve();

workerScope.onmessage = (event: MessageEvent<ManifoldBooleanRequest>) => {
  const request = event.data;
  booleanQueue = booleanQueue
    .then(async () => {
      const response = await runBoolean(request);
      if (response.type === "result") {
        workerScope.postMessage(response, [response.positions.buffer]);
        return;
      }
      workerScope.postMessage(response);
    })
    .catch((error) => {
      workerScope.postMessage({
        requestId: request.requestId,
        type: "error",
        message: error instanceof Error ? error.message : "Manifold boolean queue failed",
      } satisfies ManifoldBooleanResponse);
    });
};
