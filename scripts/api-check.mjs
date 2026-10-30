import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { applyCooking, undoCooking } from '../lib/client-cooking.ts';
import { emptyState, newItem } from '../lib/client-model.ts';
const base = process.argv[2] || 'http://127.0.0.1:8787';
assert(['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname), 'QA runs only against loopback.');
const A = `qa-a-${randomUUID()}`, B = `qa-b-${randomUUID()}`;
const recipe = {title:'QA材料',url:'https://example.com/recipe',servings:2,ingredients:[{name:'牛乳',quantity:400,unit:'ml',note:''},{name:'黒こしょう',quantity:null,unit:'',note:'量の記載なし'}]};
const results = [];
async function call(owner, path, method='GET', body, extra={}) {
  return fetch(base+path,{method,headers:{...(owner?{'oai-authenticated-user-id':owner}:{}),...(method!=='GET'?{origin:base}:{}),...(body && !(body instanceof FormData)?{'Content-Type':'application/json'}:{}),...extra},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
}
async function check(name, fn) { await fn(); results.push({name,result:'pass'}); console.log(`PASS ${name}`); }
await check('Unauthenticated state is rejected',async()=>assert.equal((await call(null,'/api/state')).status,401));
await check('D1 and R2 bindings are available',async()=>{const r=await (await call(null,'/api/health')).json(); assert.equal(r.storage,'d1');assert.equal(r.attachments,true);});
await check('New owner has an empty snapshot',async()=>{const r=await (await call(A,'/api/state')).json();assert.equal(r.state,null);assert.equal(r.revision,0);assert.equal(r.owner,A);});
await check('First snapshot is saved',async()=>{const r=await call(A,'/api/state','PUT',{owner:A,revision:0,state:{version:3,items:[],mealRecipe:recipe,marker:'a'}});assert.equal(r.status,200);assert.equal((await r.json()).revision,1);});
await check('Saved snapshot and unknown recipe quantities are durable',async()=>{const r=await (await call(A,'/api/state')).json();assert.equal(r.state.marker,'a');assert.equal(r.state.version,3);assert.deepEqual(r.state.mealRecipe,recipe);assert.equal(r.revision,1);});
await check('A different owner cannot read the snapshot',async()=>assert.equal((await (await call(B,'/api/state')).json()).state,null));
await check('Stale revision cannot overwrite current data',async()=>{const r=await call(A,'/api/state','PUT',{owner:A,revision:0,state:{version:3,marker:'stale'}});assert.equal(r.status,409);assert.equal((await r.json()).state.marker,'a');});
await check('A legacy client cannot erase recipe fields even with the current revision',async()=>{const r=await call(A,'/api/state','PUT',{owner:A,revision:1,state:{version:1,items:[],marker:'legacy'}});assert.equal(r.status,426);assert.match((await r.json()).error,/更新/u);const saved=await (await call(A,'/api/state')).json();assert.equal(saved.revision,1);assert.deepEqual(saved.state.mealRecipe,recipe);assert.equal(saved.state.marker,'a');});
await check('A missing or unsupported client version is rejected',async()=>{for(const version of [undefined,1,2,4,'3']) assert.equal((await call(A,'/api/state','PUT',{owner:A,revision:1,state:{version,items:[]}})).status,426);});
await check('Matching revision updates atomically',async()=>{const r=await call(A,'/api/state','PUT',{owner:A,revision:1,state:{version:3,items:[],mealRecipe:recipe,marker:'new'}});assert.equal(r.status,200);assert.equal((await r.json()).revision,2);});
const cooked = applyCooking([newItem('牛乳', { id:'qa-milk', unit:'ml', stock:1000, stockKnown:true, inventoryOnly:true, checkedAt:'2026-10-31' })], [], recipe, 2, 'qa-cooking', '2026-10-31T09:00:00.000Z');
assert.equal(cooked.error, undefined); assert.equal(cooked.items[0].stock, 600);
await check('Cooking stock and receipt persist together in D1', async()=>{
  const state={...emptyState(),items:cooked.items,mealRecipe:recipe,cookingHistory:cooked.history};
  assert.equal((await call(A,'/api/state','PUT',{owner:A,revision:2,state})).status,200);
  const saved=await (await call(A,'/api/state')).json();
  assert.equal(saved.state.items[0].stock,600); assert.deepEqual(saved.state.cookingHistory,cooked.history); assert.equal(saved.revision,3);
});
await check('Old v2 clients cannot erase cooking receipts or consumed inventory', async()=>{
  assert.equal((await call(A,'/api/state','PUT',{owner:A,revision:3,state:{version:2,items:[]}})).status,426);
  const saved=await (await call(A,'/api/state')).json(); assert.equal(saved.state.items[0].stock,600); assert.equal(saved.state.cookingHistory[0].id,'qa-cooking'); assert.equal(saved.revision,3);
});
await check('An undone cooking receipt survives D1 reload without replay', async()=>{
  const undone=undoCooking(cooked.items,cooked.history,'qa-cooking','2026-10-31T09:01:00.000Z'); assert.equal(undone.error,undefined);
  const state={...emptyState(),items:undone.items,mealRecipe:recipe,cookingHistory:undone.history};
  assert.equal((await call(A,'/api/state','PUT',{owner:A,revision:3,state})).status,200);
  const saved=await (await call(A,'/api/state')).json(); assert.equal(saved.state.items[0].stock,1000); assert.ok(saved.state.cookingHistory[0].undoneAt);
  const duplicate=applyCooking(saved.state.items,saved.state.cookingHistory,recipe,2,'qa-cooking'); assert.equal(duplicate.items[0].stock,1000); assert.equal(duplicate.history.length,1);
});
await check('An account switch cannot move cached data to another owner',async()=>assert.equal((await call(A,'/api/state','PUT',{owner:B,revision:2,state:{marker:'wrong'}})).status,403));
await check('Cross-origin writes are rejected',async()=>assert.equal((await call(A,'/api/state','PUT',{owner:A,revision:2,state:{}},{origin:'https://example.invalid'})).status,403));
await check('Invalid snapshot shape is rejected',async()=>assert.equal((await call(A,'/api/state','PUT',{owner:A,revision:2,state:[]})).status,400));
await check('Oversized snapshots are rejected',async()=>assert.equal((await call(A,'/api/state','PUT',{owner:A,revision:2,state:{version:3,data:'x'.repeat(1024*1024+1)}})).status,413));
await check('Japanese multi-item parsing preserves quantities',async()=>{const r=await call(A,'/api/parse','POST',{text:'牛乳2本と卵1パック'});assert.equal(r.status,200);const d=await r.json();assert.equal(d.items.length,2);assert.equal(d.items[0].quantity,2);assert.equal(d.items[1].unit,'パック');assert(['local-parser','workers-ai'].includes(d.engine));});
await check('Invalid parsing input is rejected',async()=>assert.equal((await call(A,'/api/parse','POST',{text:[]})).status,400));
await check('Unauthenticated AI calls are rejected',async()=>assert.equal((await call(null,'/api/parse','POST',{text:'牛乳'})).status,401));
let fileUrl;
await check('PNG attachment uploads to R2',async()=>{const f=new FormData();f.set('file',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')],{type:'image/png'}),'qa.png');const r=await call(A,'/api/attachments','POST',f);assert.equal(r.status,201);fileUrl=(await r.json()).url;});
await check('The attachment owner can download it',async()=>{const r=await call(A,fileUrl);assert.equal(r.status,200);assert.equal(r.headers.get('x-content-type-options'),'nosniff');});
await check('Another owner cannot download the attachment',async()=>assert.equal((await call(B,fileUrl)).status,404));
await check('An executable attachment is rejected',async()=>{const f=new FormData();f.set('file',new Blob(['console.log(1)'],{type:'text/javascript'}),'qa.js');assert.equal((await call(A,'/api/attachments','POST',f)).status,415);});
await check('Unauthenticated link previews are rejected',async()=>assert.equal((await call(null,'/api/link-preview','POST',{url:'https://www.amazon.co.jp/dp/QA'})).status,401));
await check('Cross-origin link previews are rejected',async()=>assert.equal((await call(A,'/api/link-preview','POST',{url:'https://www.amazon.co.jp/dp/QA'},{origin:'https://example.invalid'})).status,403));
await check('Invalid link preview input is rejected',async()=>assert.equal((await call(A,'/api/link-preview','POST',{url:[]})).status,400));
await check('Private link preview destinations are rejected',async()=>assert.equal((await call(A,'/api/link-preview','POST',{url:'https://127.0.0.1/'})).status,400));
await check('Unknown shopping hosts return manual naming without fetching',async()=>{const r=await call(A,'/api/link-preview','POST',{url:'https://shop.example.com/item'});assert.equal(r.status,200);const d=await r.json();assert.equal(d.resolved,false);assert.equal(d.title,'');assert.match(d.message,/商品名/u);});
// Raw audio is checked before model configuration or inference.
async function audioCall(owner, body, extra={}) {
  return fetch(base+'/api/transcribe',{method:'POST',headers:{...(owner?{'oai-authenticated-user-id':owner}:{}),origin:base,'Content-Type':'audio/wav',...extra},body});
}
await check('Unauthenticated audio is rejected',async()=>assert.equal((await audioCall(null,new Uint8Array(44))).status,401));
await check('Cross-origin audio is rejected',async()=>assert.equal((await audioCall(A,new Uint8Array(44),{origin:'https://example.invalid'})).status,403));
await check('Unsupported audio MIME is rejected',async()=>assert.equal((await audioCall(A,new Uint8Array(44),{'Content-Type':'text/plain'})).status,415));
await check('A forged audio header is rejected',async()=>assert.equal((await audioCall(A,new Uint8Array(44))).status,415));
await check('Empty recordings are rejected',async()=>assert.equal((await audioCall(A,new Uint8Array())).status,400));
await check('Audio over eight MiB is rejected',async()=>assert.equal((await audioCall(A,new Uint8Array(8*1024*1024+1))).status,413));
await mkdir('outputs',{recursive:true});
await writeFile('outputs/api-check.json',JSON.stringify({at:new Date().toISOString(),base,passed:results.length,results},null,2));
console.log(`${results.length}/${results.length} API checks passed`);
