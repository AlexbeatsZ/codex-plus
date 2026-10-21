(() => {
  const version = 1;
  const previous = globalThis.__codexPlusPdfPreview;
  if (previous?.version === version && previous.health().ready) return previous.health();
  previous?.dispose?.();

  // PDF.js asks the main thread for these resources when cMapUrl is omitted.
  // Supply them at that resource-loading seam, before its unconfigured factory
  // rejects the request. The PDF bytes and font programs remain untouched.
  const resources = __CODEX_PLUS_PDF_CMAPS__;
  const decoded = new Map();
  const NativeWorker = globalThis.Worker;
  if (typeof NativeWorker !== 'function') return { ready: false };
  let served = 0;
  let enabled = true;

  function onMessage(worker, event) {
    const message = event.data;
    const legacy = message?.action === 'FetchBuiltInCMap';
    const current = message?.action === 'FetchBinaryData'
      && message.data?.type === 'cMapReaderFactory';
    if (!enabled || (!legacy && !current)
      || !Number.isSafeInteger(message.callbackId) || message.callbackId <= 0
      || typeof message.targetName !== 'string' || !/^d\d+$/.test(message.targetName)
      || message.sourceName !== `${message.targetName}_worker`
      || !Object.hasOwn(resources, message.data?.name)) return;

    const name = message.data.name;
    try {
      if (!decoded.has(name)) {
        decoded.set(name, Uint8Array.from(globalThis.atob(resources[name]), c => c.charCodeAt(0)));
      }
      worker.postMessage({
        sourceName: message.targetName,
        targetName: message.sourceName,
        callback: 1,
        callbackId: message.callbackId,
        data: { cMapData: decoded.get(name), isCompressed: true },
      });
      // Leave unknown resource types and failed loads to the original handler.
      event.stopImmediatePropagation();
      served += 1;
    } catch (error) {
      console.warn('[codex-plus] PDF CMap load failed', name, error);
    }
  }

  const WorkerWithCMaps = new Proxy(NativeWorker, {
    construct(target, args, newTarget) {
      const worker = Reflect.construct(target, args, newTarget);
      const listener = event => onMessage(worker, event);
      // Register before PDF.js attaches its message handler.
      worker.addEventListener('message', listener);
      return worker;
    },
  });
  globalThis.Worker = WorkerWithCMaps;
  const state = {
    version,
    health: () => ({
      ready: enabled && globalThis.Worker === WorkerWithCMaps,
      resources: Object.keys(resources).length,
      loaded: decoded.size,
      served,
    }),
    dispose: () => {
      enabled = false;
      if (globalThis.Worker === WorkerWithCMaps) globalThis.Worker = NativeWorker;
      decoded.clear();
    },
  };
  globalThis.__codexPlusPdfPreview = state;
  return state.health();
})()
