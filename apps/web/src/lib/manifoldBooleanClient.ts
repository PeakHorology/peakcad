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

/**
 * Why a worker boolean did not return geometry. `superseded` matters: the caller must abandon the
 * operation rather than recompute it on the main thread, because a newer Group/remesh already
 * owns the result. Collapsing every outcome to `null` made the stale operation run again on the
 * main thread and overwrite the newer one — the opposite of what cancelling it was meant to do.
 */
export type ManifoldBooleanOutcome =
  | { status: "ok"; positions: Float32Array }
  | { status: "superseded" }
  | { status: "failed" };

/**
 * Ceiling on a single worker boolean before it is treated as wedged.
 *
 * A hung WASM boolean previously left its promise unsettled forever, so the editor sat on a
 * permanent "computing" state with no way back. Generous enough that a legitimately heavy boolean
 * on a dense mesh finishes rather than being recomputed on the main thread.
 */
const WORKER_TIMEOUT_MS = 30_000;

type Pending = {
  resolve: (outcome: ManifoldBooleanOutcome) => void;
  timeout: ReturnType<typeof setTimeout>;
};

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, Pending>();

function settle(requestId: number, outcome: ManifoldBooleanOutcome) {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  clearTimeout(entry.timeout);
  entry.resolve(outcome);
}

function settleAll(outcome: ManifoldBooleanOutcome) {
  for (const requestId of [...pending.keys()]) settle(requestId, outcome);
}

/** Drop a worker that cannot be trusted to make progress so the next request starts clean. */
function recycleWorker() {
  worker?.terminate();
  worker = null;
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/manifoldBoolean.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<ManifoldBooleanResponse>) => {
    const message = event.data;
    settle(message.requestId, message.type === "error"
      ? { status: "failed" }
      : { status: "ok", positions: message.positions });
  };
  worker.onerror = () => {
    settleAll({ status: "failed" });
    recycleWorker();
  };
  return worker;
}

export function meshDataToTransfer(vertices: Array<[number, number, number]>, faces: Array<[number, number, number]>): MeshTransfer {
  const vert = new Float32Array(vertices.length * 3);
  for (let i = 0; i < vertices.length; i += 1) {
    const point = vertices[i];
    vert[i * 3] = point[0];
    vert[i * 3 + 1] = point[1];
    vert[i * 3 + 2] = point[2];
  }
  const tris = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i += 1) {
    const face = faces[i];
    tris[i * 3] = face[0];
    tris[i * 3 + 1] = face[1];
    tris[i * 3 + 2] = face[2];
  }
  return { vertices: vert, faces: tris };
}

export function runManifoldBooleanInWorker(request: Omit<ManifoldBooleanRequest, "requestId">): Promise<ManifoldBooleanOutcome> {
  if (typeof window === "undefined") {
    return Promise.resolve({ status: "failed" });
  }
  // Drop stale in-flight results so a slow older boolean cannot win over a newer Group/remesh.
  settleAll({ status: "superseded" });
  const active = ensureWorker();
  const requestId = nextRequestId;
  nextRequestId += 1;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      // The worker owes us a reply it is never going to send. Report failure so the caller falls
      // back to the main thread, and bin the worker because its runtime state is unknown.
      settleAll({ status: "failed" });
      recycleWorker();
    }, WORKER_TIMEOUT_MS);
    pending.set(requestId, { resolve, timeout });
    const transfer: Transferable[] = [];
    for (const mesh of request.solids) {
      transfer.push(mesh.vertices.buffer, mesh.faces.buffer);
    }
    for (const mesh of request.cutters ?? []) {
      transfer.push(mesh.vertices.buffer, mesh.faces.buffer);
    }
    try {
      active.postMessage({ ...request, requestId } satisfies ManifoldBooleanRequest, transfer);
    } catch {
      // A rejected transfer (already-detached buffer) would otherwise strand the entry and its
      // timer, and leave the caller waiting on a request the worker never received.
      settle(requestId, { status: "failed" });
      recycleWorker();
    }
  });
}

export function warmManifoldBooleanWorker() {
  if (typeof window === "undefined") return;
  try {
    ensureWorker();
  } catch {
    // Worker may be unavailable in some hosts; main-thread fallback remains.
  }
}
