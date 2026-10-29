import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import assert from 'node:assert/strict';

// Isolated protocol probe: fake credentials, local catalog and loopback mock only.
// No desktop launch/attach, production configuration writes or real inference.
const argument = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const binary = argument('binary') || process.env.CODEX_PLUS_NATIVE_BIN || (process.platform === 'darwin' ? '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex' : null);
assert.ok(binary, 'Pass --binary=<official bundled codex executable>');
assert.ok(fs.existsSync(binary), 'Official native executable does not exist');
const catalogSource = argument('catalog') || path.join(os.homedir(), '.codex', 'models_cache.json');
const sourceModels = JSON.parse(fs.readFileSync(catalogSource, 'utf8')).models;
assert.ok(sourceModels?.[0]?.slug, 'Catalog must contain a native model template');
const parent = process.platform === 'win32' ? path.join(os.tmpdir(), '.agents') : '/tmp/.agents';
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, 'codex-plus-remote-list-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);
const model = sourceModels[0];
const catalog = path.join(home, 'models.json');
const routes = ['cp-probe-api', 'cp-pool-probe'];
fs.writeFileSync(catalog, JSON.stringify({ models: [model.slug, ...routes].map(slug => ({ ...model, slug, display_name: slug, tool_mode: 'direct', use_responses_lite: false })) }));
let requests = 0;
const server = http.createServer(async (request, response) => {
  for await (const _ of request) {}
  requests++;
  const item = { type: 'message', id: 'fixture-message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] };
  const events = [
    { type: 'response.created', response: { id: 'fixture-response' } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'fixture-response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/v1`;
const providers = ['openai', 'codex-plus-api', 'codex-plus-account-pool'];
fs.writeFileSync(path.join(home, 'config.toml'), `model_catalog_json=${JSON.stringify(catalog)}
openai_base_url=${JSON.stringify(base)}
chatgpt_base_url="http://127.0.0.1:9"
cli_auth_credentials_store="file"
web_search="disabled"
` + providers.slice(1).map(provider => `[model_providers.${provider}]
name="fixture"
base_url=${JSON.stringify(base)}
wire_api="responses"
experimental_bearer_token="fixture"
requires_openai_auth=false
supports_websockets=false
request_max_retries=0
stream_max_retries=0
`).join('') + `[features]
plugins=false
apps=false
[analytics]
enabled=false
`);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|KEY|AUTH|PROXY|CODEX|OPENAI/.test(key)));
Object.assign(env, { CODEX_HOME: home, HOME: root, OPENAI_API_KEY: 'fixture', CODEX_DISABLE_WEBSOCKETS: '1' });
const child = spawn(binary, ['app-server', '--listen', 'stdio://'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let stderr = '';
child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4000); });
const lines = createInterface({ input: child.stdout });
const pending = new Map();
const eventWaits = [];
let sequence = 0;
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const call = pending.get(message.id);
  if (call) {
    clearTimeout(call.timer);
    pending.delete(message.id);
    message.error ? call.reject(Error(JSON.stringify(message.error))) : call.resolve(message.result);
  }
  for (const wait of eventWaits) if (message.method === wait.method && wait.filter(message.params)) {
    clearTimeout(wait.timer);
    wait.resolve(message.params);
  }
});
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('timeout ' + method + ' ' + stderr)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
function waitFor(method, filter) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('event timeout ' + method + ' ' + stderr)), 15000);
    eventWaits.push({ method, filter, resolve, reject, timer });
  });
}
try {
  await rpc('initialize', { clientInfo: { name: 'provider_visibility_probe', version: '1' }, capabilities: { experimentalApi: true } });
  child.stdin.write('{"method":"initialized"}\n');
  const nativeModels = await rpc('model/list', { includeHidden: true, limit: 100 });
  for (const route of routes) assert.ok(nativeModels.data.some(entry => entry.model === route));
  console.log(JSON.stringify({ check: 'native-model-catalog', routes: nativeModels.data.map(entry => entry.model) }));
  for (const provider of providers) {
    const { thread } = await rpc('thread/start', { cwd: root, model: model.slug, modelProvider: provider, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: 'Reply OK. Do not call tools.' });
    const done = waitFor('turn/completed', params => params.threadId === thread.id);
    await rpc('turn/start', { threadId: thread.id, model: model.slug, input: [{ type: 'text', text: 'Isolated fixture' }] });
    const completion = await done;
    if (completion.turn.status !== 'completed') throw Error(JSON.stringify(completion.turn));
    console.log(JSON.stringify({ check: 'fixture-created', provider: thread.modelProvider }));
  }
  // 0.165.0-alpha.1.2: omitted/null select the configured provider; [] selects all.
  for (const [name, extra] of [['omitted', {}], ['null', { modelProviders: null }], ['empty-array', { modelProviders: [] }], ['explicit-api', { modelProviders: ['codex-plus-api'] }]]) {
    const result = await rpc('thread/list', { limit: 100, useStateDbOnly: true, ...extra });
    console.log(JSON.stringify({ check: name, providers: result.data.map(thread => thread.modelProvider).sort(), count: result.data.length }));
    assert.equal(result.data.length, name === 'empty-array' ? 3 : 1);
  }
  const { thread } = await rpc('thread/start', { cwd: root, model: routes[0], modelProvider: 'openai', approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: 'Reply OK. Do not call tools.' });
  for (const route of routes) {
    const done = waitFor('turn/completed', params => params.threadId === thread.id);
    await rpc('turn/start', { threadId: thread.id, model: route, input: [{ type: 'text', text: 'Isolated unified provider fixture' }] });
    assert.equal((await done).turn.status, 'completed');
  }
  const visible = await rpc('thread/list', { limit: 100, modelProviders: null, useStateDbOnly: true });
  assert.ok(visible.data.some(entry => entry.id === thread.id && entry.modelProvider === 'openai'));
  console.log(JSON.stringify({ check: 'unified-provider-routes', sameThread: true, routes, provider: 'openai', visibleWithDefaultFilter: true }));
  console.log(JSON.stringify({ mockRequests: requests, realModelRequests: 0 }));
} finally {
  for (const { timer } of pending.values()) clearTimeout(timer);
  for (const { timer } of eventWaits) clearTimeout(timer);
  lines.close();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ cleanup: root, removed: !fs.existsSync(root) }));
}
