import type { CadModifierWorkerResponse } from "@/lib/cadModifierTypes";

let preloaded: Worker | null = null;
let preloadPromise: Promise<void> | null = null;

/** Load the fillet/chamfer engine once, before the first tool use. */
export function preloadCadModifierWorker(): Promise<void> {
  if (preloadPromise) return preloadPromise;
  preloadPromise = new Promise((resolve) => {
    try {
      const worker = new Worker(new URL("../workers/cadModifier.worker.ts", import.meta.url), { type: "module" });
      const finish = () => {
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(finish, 20000);
      worker.onmessage = (event: MessageEvent<CadModifierWorkerResponse>) => {
        if (event.data?.type === "warmup") {
          preloaded = worker;
          finish();
        }
      };
      worker.onerror = () => finish();
      worker.postMessage({ type: "warmup", requestId: 0 });
    } catch {
      resolve();
    }
  });
  return preloadPromise;
}

/** The editor adopts the worker started on the startup screen. */
export function takePreloadedCadModifierWorker(): Worker | null {
  const worker = preloaded;
  preloaded = null;
  return worker;
}
