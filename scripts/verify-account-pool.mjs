// Explicit, isolated integration test. Never launches/attaches the desktop app.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';

const arg=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
const binary=arg('binary');const authDir=arg('auth-dir');const model=arg('model');
assert.ok(binary&&authDir&&model,'Pass --binary=<debug binary> --auth-dir=<vault> --model=<native model>');
const parent=process.platform==='win32'?path.join(os.tmpdir(),'.agents'): '/tmp/.agents';
fs.mkdirSync(parent,{recursive:true});
const root=fs.mkdtempSync(path.join(parent,'codex-plus-pool-smoke-'));
let child,output;
try{
const state=path.join(root,'state');const home=path.join(root,'home');
fs.mkdirSync(path.join(state,'accounts'),{recursive:true,mode:0o700});fs.mkdirSync(home,{recursive:true});
const ids=[];
for(const name of fs.readdirSync(authDir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){
  const raw=fs.readFileSync(path.join(authDir,name));const doc=JSON.parse(raw);
  try{const claims=JSON.parse(Buffer.from(doc.tokens.access_token.split('.')[1],'base64url'));if(claims.exp<=Date.now()/1000+120)continue;}catch{continue;}
  fs.writeFileSync(path.join(state,'accounts',name),raw,{mode:0o600});ids.push(name.slice(0,-5));
}
assert.ok(ids.length>=2,'Need two unexpired saved accounts for cross-account verification');
const config={enabled:true,accountOrder:ids,models:[{modelId:model,displayName:'',visible:true}],proxyUrl:arg('proxy')||''};
const save=()=>fs.writeFileSync(path.join(state,'subscription.json'),JSON.stringify(config),{mode:0o600});save();
child=spawn(path.resolve(binary),['--broker-only','--test-config'],{env:{...process.env,CODEX_HOME:home,CODEX_PLUS_STATE_DIR:state},stdio:['ignore','pipe','pipe']});
child.stderr.on('data',()=>{});
output=createInterface({input:child.stdout});
  const first=await Promise.race([once(output,'line').then(([l])=>JSON.parse(l)),once(child,'exit').then(()=>{throw Error('Isolated broker exited before readiness')}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Broker readiness timeout')),15000);t.unref();})]);
  const base=`http://127.0.0.1:${first.brokerPort}/v1`;
  const route=`cp-pool-${Buffer.from(model).toString('base64url')}`;
  const headers={Authorization:'Bearer codex-plus-loopback','Content-Type':'application/json'};
  async function call(body){
    const response=await fetch(`${base}/responses`,{method:'POST',headers,body:JSON.stringify({...body,model:route}),signal:AbortSignal.timeout(120000)});
    const text=await response.text();
    if(!response.ok){let code;try{code=JSON.parse(text).error?.code;}catch{}throw Error(`Broker HTTP ${response.status}; code=${code||'unknown'}`);}
    const events=text.split(/\r?\n/).filter(l=>l.startsWith('data:')).flatMap(l=>{try{return [JSON.parse(l.slice(5).trim())]}catch{return []}});
    const completed=events.find(e=>e.type==='response.completed');
    if(!completed){const failure=events.find(e=>e.type==='response.failed'||e.type==='error');throw Error(`No response.completed; code=${failure?.response?.error?.code||failure?.code||'unknown'}`);}
    return {recordId:response.headers.get('x-codex-plus-account-record'),output:completed.response.output,text:events.filter(e=>e.type==='response.output_text.delta').map(e=>e.delta).join('')};
  }
  const catalog=await fetch(`${base}/models`,{headers}).then(r=>r.json());assert.ok(catalog.data.some(m=>m.id===route));
  console.log(JSON.stringify({check:'broker-model-catalog',passed:true}));
  const input=[{role:'user',content:[{type:'input_text',text:'Call pool_probe once, then report the tool result exactly, without other text.'}]}];
  const tools=[{type:'function',name:'pool_probe',description:'Returns the verification marker.',parameters:{type:'object',properties:{},required:[],additionalProperties:false}}];
  const common={instructions:'Follow the user exactly. This is an authorized local routing integration test.',store:false,stream:true,reasoning:{effort:'low'},include:['reasoning.encrypted_content']};
  const firstTurn=await call({...common,input,tools,tool_choice:{type:'function',name:'pool_probe'}});
  assert.equal(firstTurn.recordId,ids[0],'First request must use account A');
  const tool=firstTurn.output.find(o=>o.type==='function_call'&&o.name==='pool_probe');assert.ok(tool?.call_id,'model must produce a real function call');
  console.log(JSON.stringify({check:'real-function-call',passed:true}));
  config.accountOrder=[ids[1],ids[0],...ids.slice(2)];save();
  const continuedInput=[...input,...firstTurn.output,{type:'function_call_output',call_id:tool.call_id,output:'TOOL_FLOW_OK'}];
  const nextTurn=await call({...common,input:continuedInput,tools,tool_choice:'none'});assert.equal(nextTurn.text.trim(),'TOOL_FLOW_OK');
  assert.equal(nextTurn.recordId,ids[1],'Continuation must use account B');
  console.log(JSON.stringify({check:'cross-account-tool-result-continuation',passed:true}));
  if(arg('app-server')){
    config.accountOrder=ids;save();
    const provider='codex-plus-account-pool';
    const app=spawn(arg('app-server'),['app-server','--listen','stdio://',
      '-c',`model_provider="${provider}"`,
      '-c','features.remote_compaction_v2=true','-c','web_search="disabled"'],
      {cwd:root,env:{...process.env,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});
    app.stderr.on('data',()=>{});
    const lines=createInterface({input:app.stdout});let seq=0;const pending=new Map();const events=[];
    lines.on('line',line=>{
      let msg;try{msg=JSON.parse(line)}catch{return;}
      if(msg.id!==undefined&&pending.has(msg.id)){
        const {resolve,reject,timer}=pending.get(msg.id);clearTimeout(timer);pending.delete(msg.id);
        if(msg.error)reject(Error(`app-server ${msg.error.code}: ${msg.error.message}`));else resolve(msg.result);
      }else if(msg.method){events.push(msg);}
    });
    const rpc=(method,params)=>new Promise((resolve,reject)=>{
      const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error(`app-server timeout: ${method}`));},120000);timer.unref();
      pending.set(id,{resolve,reject,timer});app.stdin.write(JSON.stringify({id,method,params})+'\n');
    });
    const wait=async(method,predicate,offset=0)=>{
      const limit=Date.now()+120000;
      while(Date.now()<limit){const e=events.slice(offset).find(e=>e.method===method&&predicate(e.params));if(e)return e.params;await new Promise(r=>setTimeout(r,100));}
      throw Error(`app-server event timeout: ${method}`);
    };
    try{
      await rpc('initialize',{clientInfo:{name:'codex_plus_pool_smoke',version:'0.3.3'},capabilities:{experimentalApi:true}});
      app.stdin.write(JSON.stringify({method:'initialized'})+'\n');
      const started=await rpc('thread/start',{cwd:root,model:route,modelProvider:provider,approvalPolicy:'never',sandbox:'read-only',baseInstructions:'Follow user instructions exactly. Do not invoke tools.'});
      const threadId=started.thread.id;
      async function turn(text){
        const offset=events.length;
        const {turn}=await rpc('turn/start',{threadId,model:route,effort:'low',input:[{type:'text',text}]});
        const result=await wait('turn/completed',p=>p.turn.id===turn.id,offset);
        assert.equal(result.turn.status,'completed',`app-server turn failed: ${result.turn.error?.codexErrorInfo||'unknown'}`);
        return events.slice(offset).filter(e=>e.method==='item/agentMessage/delta').map(e=>e.params.delta).join('');
      }
      assert.equal((await turn('Remember marker RPC_POOL_OK. Reply with exactly READY.')).trim(),'READY');
      const offset=events.length;await rpc('thread/compact/start',{threadId});
      await wait('item/completed',p=>p.threadId===threadId&&p.item.type==='contextCompaction',offset);
      console.log(JSON.stringify({check:'native-app-server-compaction',passed:true}));
      config.accountOrder=[ids[1],ids[0],...ids.slice(2)];save();
      assert.equal((await turn('What was the marker? Reply with only the marker.')).trim(),'RPC_POOL_OK');
      console.log(JSON.stringify({check:'native-app-server-same-thread-cross-account-resume',passed:true}));
    }finally{
      lines.close();for(const {timer} of pending.values())clearTimeout(timer);
      if(app.exitCode===null){const exit=once(app,'exit');app.kill('SIGTERM');await exit;}
    }
  }
}finally{
  output?.close();if(child&&child.exitCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit;}
  fs.rmSync(root,{recursive:true,force:true});
}
