import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.argv[2] || 'http://127.0.0.1:8787';
assert(['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname), 'QA runs only against loopback.');
const A = `qa-a-${randomUUID()}`, B = `qa-b-${randomUUID()}`;
const results = [];
async function call(owner, path, method='GET', body, extra={}) {
  return fetch(base+path,{method,headers:{...(owner?{'oai-authenticated-user-id':owner}:{}),...(method!=='GET'?{origin:base}:{}),...(body && !(body instanceof FormData)?{'Content-Type':'application/json'}:{}),...extra},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
}
async function check(name, fn) { await fn(); results.push({name,result:'pass'}); console.log(`PASS ${name}`); }
await check('Unauthenticated state is rejected',async()=>assert.equal((await call(null,'/api/state')).status,401));
await check('D1 and R2 bindings are available',async()=>{const r=await (await call(null,'/api/health')).json(); assert.equal(r.storage,'d1');assert.equal(r.attachments,true);});
await check('New owner has an empty snapshot',async()=>{const r=await (await call(A,'/api/state')).json();assert.equal(r.state,null);assert.equal(r.revision,0);assert.equal(r.owner,A);});
await check('First snapshot is saved',async()=>{const r=await call(A,'/api/state','PUT',{owner:A,revision:0,state:{version:1,items:[],marker:'a'}});assert.equal(r.status,200);assert.equal((await r.json()).revision,1);});
await check('Saved snapshot is durable',async()=>{const r=await (await call(A,'/api/state')).json();assert.equal(r.state.marker,'a');assert.equal(r.revision,1);});
await check('A different owner cannot read the snapshot',async()=>assert.equal((await (await call(B,'/api/state')).json()).state,null));
await check('Stale revision cannot overwrite current data',async()=>{const r=await call(A,'/api/state','PUT',{owner:A,revision:0,state:{marker:'stale'}});assert.equal(r.status,409);assert.equal((await r.json()).state.marker,'a');});
await check('Matching revision updates atomically',async()=>{const r=await call(A,'/api/state','PUT',{owner:A,revision:1,state:{version:1,items:[],marker:'new'}});assert.equal(r.status,200);assert.equal((await r.json()).revision,2);});
await check('An account switch cannot move cached data to another owner',async()=>assert.equal((await call(A,'/api/state','PUT',{owner:B,revision:2,state:{marker:'wrong'}})).status,403));
await check('Cross-origin writes are rejected',async()=>assert.equal((await call(A,'/api/state','PUT',{owner:A,revision:2,state:{}},{origin:'https://example.invalid'})).status,403));
await check('Invalid snapshot shape is rejected',async()=>assert.equal((await call(A,'/api/state','PUT',{owner:A,revision:2,state:[]})).status,400));
await check('Oversized snapshots are rejected',async()=>assert.equal((await call(A,'/api/state','PUT',{owner:A,revision:2,state:{data:'x'.repeat(1024*1024+1)}})).status,413));
await check('Japanese multi-item parsing preserves quantities',async()=>{const r=await call(A,'/api/parse','POST',{text:'牛乳2本と卵1パック'});assert.equal(r.status,200);const d=await r.json();assert.equal(d.items.length,2);assert.equal(d.items[0].quantity,2);assert.equal(d.items[1].unit,'パック');assert(['local-parser','workers-ai'].includes(d.engine));});
await check('Invalid parsing input is rejected',async()=>assert.equal((await call(A,'/api/parse','POST',{text:[]})).status,400));
await check('Unauthenticated AI calls are rejected',async()=>assert.equal((await call(null,'/api/parse','POST',{text:'牛乳'})).status,401));
let fileUrl;
await check('PNG attachment uploads to R2',async()=>{const f=new FormData();f.set('file',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')],{type:'image/png'}),'qa.png');const r=await call(A,'/api/attachments','POST',f);assert.equal(r.status,201);fileUrl=(await r.json()).url;});
await check('The attachment owner can download it',async()=>{const r=await call(A,fileUrl);assert.equal(r.status,200);assert.equal(r.headers.get('x-content-type-options'),'nosniff');});
await check('Another owner cannot download the attachment',async()=>assert.equal((await call(B,fileUrl)).status,404));
await check('An executable attachment is rejected',async()=>{const f=new FormData();f.set('file',new Blob(['console.log(1)'],{type:'text/javascript'}),'qa.js');assert.equal((await call(A,'/api/attachments','POST',f)).status,415);});
await mkdir('outputs',{recursive:true});
await writeFile('outputs/api-check.json',JSON.stringify({at:new Date().toISOString(),base,passed:results.length,results},null,2));
console.log(`${results.length}/${results.length} API checks passed`);
