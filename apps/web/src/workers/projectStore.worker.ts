import { ProjectStoreHost, type ProjectStoreRequest, type ProjectStoreResponse } from "@/lib/projectStoreOps";

const workerScope = globalThis as unknown as DedicatedWorkerGlobalScope;

const host = new ProjectStoreHost(workerScope.indexedDB, (deleted) => {
  workerScope.postMessage({ requestId: 0, type: "collected", deleted } satisfies ProjectStoreResponse);
});

workerScope.onmessage = (event: MessageEvent<ProjectStoreRequest>) => {
  void host.handle(event.data).then((response) => workerScope.postMessage(response));
};
