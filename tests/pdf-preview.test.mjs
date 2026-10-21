import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const resources = JSON.parse(readFileSync(new URL('../assets/pdf-cmaps.json', import.meta.url)));
const script = readFileSync(new URL('../assets/pdf-preview.js', import.meta.url), 'utf8')
  .replace('__CODEX_PLUS_PDF_CMAPS__', JSON.stringify(resources));

function setup() {
  class Worker {
    constructor(...args) { this.args = args; this.listeners = []; this.sent = []; }
    addEventListener(type, listener) { if (type === 'message') this.listeners.push(listener); }
    postMessage(data) { this.sent.push(data); }
    receive(data) {
      let stopped = false;
      const event = { data, stopImmediatePropagation() { stopped = true; } };
      for (const listener of this.listeners) {
        listener(event);
        if (stopped) break;
      }
      return stopped;
    }
  }
  const context = vm.createContext({ Worker, atob, console });
  vm.runInContext(script, context);
  return { context, NativeWorker: Worker, state: context.__codexPlusPdfPreview };
}

function request(action = 'FetchBinaryData', name = 'Adobe-GB1-UCS2') {
  return { action, sourceName: 'd0_worker', targetName: 'd0', callbackId: 7,
    data: { type: 'cMapReaderFactory', name } };
}

test('PDF.js CMap callback gets real local binary data before its missing-URL handler', () => {
  const { context, NativeWorker, state } = setup();
  const worker = new context.Worker('pdf.worker.mjs', { type: 'module' });
  assert.ok(worker instanceof NativeWorker);
  assert.equal(worker.args[0], 'pdf.worker.mjs');
  let originalCalls = 0;
  worker.addEventListener('message', () => originalCalls++);
  assert.equal(worker.receive(request()), true);
  assert.equal(originalCalls, 0);
  const reply = worker.sent[0];
  assert.equal(reply.callback, 1);
  assert.equal(reply.callbackId, 7);
  assert.equal(reply.sourceName, 'd0');
  assert.equal(reply.targetName, 'd0_worker');
  assert.equal(reply.data.isCompressed, true);
  assert.deepEqual(Buffer.from(reply.data.cMapData), Buffer.from(resources['Adobe-GB1-UCS2'], 'base64'));
  assert.equal(state.health().served, 1);
});

test('Legacy PDF.js CMap requests work; unrelated worker traffic remains intact', () => {
  const { context } = setup();
  const worker = new context.Worker('worker.js');
  assert.equal(worker.receive(request('FetchBuiltInCMap')), true);
  assert.equal(worker.receive(request('FetchBinaryData', 'missing-resource')), false);
  assert.equal(worker.receive({ ...request(), data: { type: 'wasmFactory', name: 'Adobe-GB1-UCS2' } }), false);
  assert.equal(worker.receive({ ...request(), sourceName: 'other-worker' }), false);
  assert.equal(worker.receive({ ...request(), action: 'GetDoc' }), false);
  assert.equal(worker.sent.length, 1);
});

test('Repeated injection is idempotent, disposal restores Worker, and reinstall works', () => {
  const { context, NativeWorker, state } = setup();
  const wrapped = context.Worker;
  const oldWorker = new context.Worker('worker.js');
  vm.runInContext(script, context);
  assert.equal(context.Worker, wrapped);
  state.dispose();
  assert.equal(context.Worker, NativeWorker);
  assert.equal(oldWorker.receive(request()), false);
  vm.runInContext(script, context);
  assert.equal(new context.Worker('new-worker.js').receive(request()), true);
});

test('The packaged resource set covers simplified/traditional Chinese, Japanese, and Korean', () => {
  assert.equal(Object.keys(resources).length, 168);
  for (const name of ['Adobe-GB1-UCS2', 'Adobe-CNS1-UCS2', 'Adobe-Japan1-UCS2', 'Adobe-Korea1-UCS2']) {
    assert.ok(Buffer.from(resources[name], 'base64').length > 1000, name);
  }
});
