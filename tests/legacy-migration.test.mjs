import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionToken } from '../edgeone/cloud-functions/login.js';
import { onRequest as tasks } from '../edgeone/cloud-functions/api/tasks.js';
import { onRequest as legacy } from '../edgeone/edge-functions/api/legacy-tasks.js';

const secret='migration-test-secret';
const task={id:'original',project:'旧任务',urgency:'medium',hours:1,progress:100,startDate:'2026-11-03'};
const store=(values=new Map())=>({
  async list({prefix}) {return {blobs:[...values.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))};},
  async get(key) {return values.get(key)??null;},
});
async function request() {
  return new Request('https://example.com/api/tasks',{headers:{cookie:`lexi_session=${await createSessionToken(secret)}`}});
}

test('the legacy migration endpoint requires authentication and is read-only',async()=>{
  let reads=0;
  const env={SESSION_SECRET:secret,LEXI_KV:{async get(){reads+=1;return JSON.stringify({tasks:[task],updatedAt:'legacy-v1'});}}};
  assert.equal((await legacy({request:new Request('https://example.com/api/legacy-tasks'),env})).status,401);
  assert.equal(reads,0);
  const authenticated=await request();
  const denied=await legacy({request:new Request(authenticated,{method:'PUT'}),env});
  assert.equal(denied.status,405);
  assert.equal(reads,0);
  const response=await legacy({request:authenticated,env});
  assert.deepEqual((await response.json()).tasks,[task]);
});

test('Cloud Functions retain the KV tasks through the authenticated edge bridge',async()=>{
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    assert.equal(new URL(url).pathname,'/api/legacy-tasks');
    assert.match(options.headers.cookie,/^lexi_session=/);
    return Response.json({tasks:[task],updatedAt:'legacy-v1'});
  };
  try {
    const response=await tasks({request:await request(),env:{SESSION_SECRET:secret,LEXI_BLOB:store()}});
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{tasks:[task],updatedAt:'legacy-v1'});
  } finally {globalThis.fetch=originalFetch;}
});

test('a failed legacy bridge cannot silently become an empty cloud task list',async()=>{
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(null,{status:503});
  try {
    const response=await tasks({request:await request(),env:{SESSION_SECRET:secret,LEXI_BLOB:store()}});
    assert.equal(response.status,503);
    assert.equal((await response.json()).code,'READ_FAILED');
  } finally {globalThis.fetch=originalFetch;}
});

test('after a durable snapshot the old KV service is no longer required',async()=>{
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error('the legacy service must not be contacted');};
  const values=new Map([['snapshots/1.json',{tasks:[task],throughKey:'operations/1.json',createdAt:1}]]);
  try {
    const response=await tasks({request:await request(),env:{SESSION_SECRET:secret,LEXI_BLOB:store(values)}});
    assert.equal(response.status,200);
    assert.deepEqual((await response.json()).tasks,[task]);
  } finally {globalThis.fetch=originalFetch;}
});
