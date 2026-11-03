import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/legacy/app.js', import.meta.url), 'utf8');
const persistence = source.slice(source.indexOf('  function readSyncState()'), source.indexOf('  const uid ='));
const task = (patch = {}) => ({id:'a', project:'测试项目', progress:0, notes:'', ...patch});

function client({ initial = [task()], remote = initial, offline = false, storageFails = false, beforePut, conflictCount = 0 } = {}) {
  const storage = new Map([['paqi_tasks_v1', JSON.stringify(initial)], ['paqi_cloud_sync_v1', 'v1']]);
  let server = structuredClone(remote), version = 1, writes = 0;
  const messages = [], events = {};
  const context = vm.createContext({
    window: {addEventListener: (name, fn) => { events[name] = fn; }, location: {replace() {}}},
    document: {addEventListener() {}, visibilityState:'visible'},
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem(key,value) { if (storageFails) throw new Error('QuotaExceededError'); storage.set(key,value); },
      removeItem: key => storage.delete(key),
    },
    renderDaily() {}, toast: msg => messages.push(msg),
    fetch: async (_url, options) => {
      if (offline) throw new Error('offline');
      if (options.method !== 'PUT') return {status:200,ok:true,json:async()=>({tasks:structuredClone(server),updatedAt:`v${version}`})};
      writes += 1;
      const body = JSON.parse(options.body);
      if (beforePut) await beforePut({body, writes});
      if (conflictCount > 0 || body.expectedUpdatedAt !== `v${version}`) {
        if (conflictCount > 0) { conflictCount -= 1; version += 1; }
        return {status:409,ok:false,json:async()=>({tasks:structuredClone(server),updatedAt:`v${version}`})};
      }
      server = structuredClone(body.tasks); version += 1;
      return {status:200,ok:true,json:async()=>({tasks:structuredClone(server),updatedAt:`v${version}`})};
    },
  });
  vm.runInContext(`
    const STORE_KEY='paqi_tasks_v1', SYNC_KEY='paqi_cloud_sync_v1', DIRTY_KEY='paqi_cloud_dirty_v1', DIRTY_BASE_KEY='paqi_cloud_dirty_base_v1';
    let tasks=load(), syncLocalBase=readDirtyBase() ?? cloneTasks(tasks), syncedTasks=cloneTasks(syncLocalBase);
    let dirty=hasUnsyncedChanges(), localCacheSaved=true, cloudLoaded=false, cloudUpdatedAt=null;
    ${persistence}
    globalThis.api={loadCloudTasks, save, syncTasks, mergeConcurrentChanges, sameTask,
      flush:()=>syncQueue, get:()=>tasks, set:(value)=>{tasks=value;}, dirty:()=>dirty};
  `, context);
  return {api:context.api, storage, messages, events, remote:()=>server, writes:()=>writes,
    reconnect() { offline = false; }, serverEdit(value) {server=structuredClone(value);version+=1;} };
}

test('offline startup retains the cached ancestor and does not manufacture conflict copies', async () => {
  const c=client({offline:true});
  await assert.rejects(c.api.loadCloudTasks());
  c.api.set([task({progress:50})]); c.api.save(); await c.api.flush();
  assert.deepEqual(JSON.parse(c.storage.get('paqi_cloud_dirty_base_v1')), [task()]);
  c.reconnect(); await c.api.syncTasks(c.api.get());
  assert.deepEqual(c.remote(), [task({progress:50})]);
  assert.equal(c.api.dirty(), false);
});

test('a queued delete survives an earlier in-flight save and refresh', async () => {
  let release, started;
  const pending=new Promise(resolve=>{release=resolve;});
  const ready=new Promise(resolve=>{started=resolve;});
  const c=client({beforePut:async({writes})=>{if(writes===1){started();await pending;}}});
  await c.api.loadCloudTasks();
  c.api.set([task({progress:10})]); c.api.save();
  await ready;
  c.api.set([]); c.api.save(); release();
  await c.api.flush();
  assert.deepEqual(c.remote(), []);
  await c.api.loadCloudTasks();
  assert.equal(c.api.get().length, 0);
});

test('concurrent changes to separate fields preserve both edits under one ID', async () => {
  const c=client(); await c.api.loadCloudTasks();
  c.serverEdit([task({notes:'远端备注'})]);
  c.api.set([task({progress:75})]); c.api.save(); await c.api.flush();
  assert.deepEqual(c.remote(), [task({progress:75,notes:'远端备注'})]);
});

test('repeated version conflicts rebase their ancestor each time', async () => {
  const c=client({conflictCount:3}); await c.api.loadCloudTasks();
  c.api.set([task({progress:100})]);c.api.save();await c.api.flush();
  assert.equal(c.writes(),4);
  assert.deepEqual(c.remote(),[task({progress:100})]);
  assert.equal(c.api.dirty(),false);
});

test('remote deletion is not resurrected by a stale edit', async () => {
  const c=client();await c.api.loadCloudTasks();c.serverEdit([]);
  c.api.set([task({progress:10})]);c.api.save();await c.api.flush();
  assert.deepEqual(c.remote(),[]);
});

test('initial loading preserves an edit made while the GET was pending', async () => {
  const c=client();const loading=c.api.loadCloudTasks();
  c.api.set([task({progress:40})]);c.api.save();await loading;await c.api.flush();
  assert.deepEqual(c.remote(),[task({progress:40})]);
});

test('field order does not count as a task modification', () => {
  const c=client();
  assert.equal(c.api.sameTask({id:'a',progress:50},{progress:50,id:'a'}),true);
});

test('storage failure never claims the data is safely cached', async () => {
  const c=client({storageFails:true,offline:true});
  c.api.set([]);c.api.save();await c.api.flush();
  assert.match(c.messages.at(-1),/本机存储也不可用/);
  assert.doesNotMatch(c.messages.at(-1),/已保存在本机/);
});

test('connectivity recovery automatically retries pending changes', async () => {
  const c=client({offline:true});c.api.set([task({progress:20})]);c.api.save();await c.api.flush();
  c.reconnect();c.events.online();await c.api.flush();
  assert.deepEqual(c.remote(),[task({progress:20})]);
});
