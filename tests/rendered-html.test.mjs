import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createSessionToken,
  isSessionTokenValid,
  loginPage,
  onRequest as loginRequest,
} from "../edgeone/cloud-functions/login.js";
import { onRequest as tasksRequest } from "../edgeone/cloud-functions/api/tasks.js";
import { middleware } from "../edgeone/middleware.js";

const root = new URL("../", import.meta.url);
const secret = "test-session-secret";

class BlobStore {
  values = new Map();
  getCalls = 0;

  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.values.has(key)) {
      const error = new Error("blob already exists");
      error.code = "PRECONDITION_FAILED";
      throw error;
    }
    this.values.set(key, structuredClone(value));
  }

  async get(key) {
    this.getCalls += 1;
    return this.values.has(key) ? structuredClone(this.values.get(key)) : null;
  }

  async delete(key) {
    this.values.delete(key);
  }

  async list({ prefix = "" } = {}) {
    return {
      blobs: Array.from(this.values.keys())
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => ({ key })),
    };
  }
}

const emptyLegacyStore = { async get() { return null; } };

function validTask(overrides = {}) {
  return {
    id: "task-1",
    createdAt: 1,
    project: "排期台",
    urgency: "medium",
    hours: 1,
    progress: 0,
    reviewDate: "",
    startDate: "2026-08-08",
    duration: 1,
    notes: "",
    reqDoc: "",
    ...overrides,
  };
}

async function authorizedRequest(method, body) {
  const token = await createSessionToken(secret);
  return new Request("https://example.com/api/tasks", {
    method,
    headers: {
      cookie: `lexi_session=${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("renders the current product login and keeps short mobile screens scrollable", () => {
  const html = loginPage(true, "");
  assert.match(html, /Lexi's workday/);
  assert.match(html, /密码错误/);
  assert.match(html, /overflow-y:auto/);
  assert.doesNotMatch(html, /\.login-side\{[^}]*overflow:hidden/);
  assert.doesNotMatch(html, /\.card\{[^}]*max-height:100%/);
});

test("session tokens expire on the server", async () => {
  const now = Date.now();
  const validExpiry = Math.floor(now / 1000) + 60;
  const expiredExpiry = Math.floor(now / 1000) - 1;
  const valid = await createSessionToken(secret, validExpiry);
  const expired = await createSessionToken(secret, expiredExpiry);

  assert.equal(await isSessionTokenValid(valid, secret, now), true);
  assert.equal(await isSessionTokenValid(expired, secret, now), false);
  assert.equal(await isSessionTokenValid(valid, "wrong-secret", now), false);
});

test("task writes reject stale versions instead of overwriting cloud data", async () => {
  const blob = new BlobStore();
  const env = { SESSION_SECRET: secret, LEXI_KV: emptyLegacyStore, LEXI_BLOB: blob };

  const first = await tasksRequest({
    request: await authorizedRequest("PUT", { tasks: [validTask()], expectedUpdatedAt: null }),
    env,
  });
  assert.equal(first.status, 200);
  const saved = await first.json();
  assert.equal(blob.values.size, 1);
  const current = await tasksRequest({ request: await authorizedRequest("GET"), env });
  assert.equal((await current.json()).updatedAt, saved.updatedAt);

  const stale = await tasksRequest({
    request: await authorizedRequest("PUT", {
      tasks: [validTask({ project: "被覆盖的版本" })],
      expectedUpdatedAt: null,
    }),
    env,
  });
  assert.equal(stale.status, 409);
  assert.equal(blob.values.size, 1);
});

test("concurrent EdgeOne writes are both retained", async () => {
  let releaseInitialReads;
  const initialReadsReady = new Promise((resolve) => { releaseInitialReads = resolve; });
  class ConcurrentBlobStore extends BlobStore {
    initialReads = 0;

    async list(options) {
      if (this.values.size === 0 && this.initialReads < 2) {
        this.initialReads += 1;
        if (this.initialReads === 2) releaseInitialReads();
        await initialReadsReady;
      }
      return super.list(options);
    }
  }
  const blob = new ConcurrentBlobStore();
  const env = { SESSION_SECRET: secret, LEXI_KV: emptyLegacyStore, LEXI_BLOB: blob };
  const firstRequest = await authorizedRequest("PUT", { tasks: [validTask({ id: "first" })], expectedUpdatedAt: null });
  const secondRequest = await authorizedRequest("PUT", { tasks: [validTask({ id: "second" })], expectedUpdatedAt: null });
  const [first, second] = await Promise.all([
    tasksRequest({ request: firstRequest, env }),
    tasksRequest({ request: secondRequest, env }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const response = await tasksRequest({ request: await authorizedRequest("GET"), env });
  const state = await response.json();
  assert.deepEqual(state.tasks.map((task) => task.id).sort(), ["first", "second"]);
});

test("EdgeOne compacts old operation history into a snapshot", async () => {
  const blob = new BlobStore();
  const oldTimestamp = Date.now() - 10 * 60 * 1000;
  for (let index = 0; index < 100; index += 1) {
    const operationId = `${String(oldTimestamp + index).padStart(13, "0")}_${String(index).padStart(32, "0")}`;
    blob.values.set(`operations/${operationId}.json`, { id: operationId, changes: [] });
  }
  const env = { SESSION_SECRET: secret, LEXI_KV: emptyLegacyStore, LEXI_BLOB: blob };
  const before = await tasksRequest({ request: await authorizedRequest("GET"), env });
  const beforeState = await before.json();
  const write = await tasksRequest({
    request: await authorizedRequest("PUT", { tasks: [validTask()], expectedUpdatedAt: beforeState.updatedAt }),
    env,
  });
  assert.equal(write.status, 200);
  assert.equal(Array.from(blob.values.keys()).some((key) => key.startsWith("snapshots/")), true);

  blob.getCalls = 0;
  const after = await tasksRequest({ request: await authorizedRequest("GET"), env });
  assert.deepEqual((await after.json()).tasks, [validTask()]);
  assert.equal(blob.getCalls, 2);
});

test("task writes reject executable document links", async () => {
  const store = new BlobStore();
  const response = await tasksRequest({
    request: await authorizedRequest("PUT", {
      tasks: [validTask({ reqDoc: "javascript:alert(1)" })],
      expectedUpdatedAt: null,
    }),
    env: { SESSION_SECRET: secret, LEXI_KV: emptyLegacyStore, LEXI_BLOB: store },
  });
  assert.equal(response.status, 400);
});

test("failed storage writes return a structured error instead of escaping the handler", async () => {
  class FailingStore extends BlobStore {
    async setJSON() { throw new Error("simulated storage failure"); }
  }
  const response = await tasksRequest({
    request: await authorizedRequest("PUT", { tasks: [validTask()], expectedUpdatedAt: null }),
    env: { SESSION_SECRET: secret, LEXI_KV: emptyLegacyStore, LEXI_BLOB: new FailingStore() },
  });
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.code, "SYNC_FAILED");
  assert.equal(result.stage, "write");
  assert.equal(typeof result.requestId, "string");
});

test("saving a long history reuses reads and stays within an edge request budget", async () => {
  class LimitedStore extends BlobStore {
    async get(key) {
      if (this.getCalls >= 64) throw new Error("subrequest limit exceeded");
      return super.get(key);
    }
  }
  const blob = new LimitedStore();
  for (let index = 0; index < 50; index += 1) {
    const id = `${Date.now()}_${String(index).padStart(32, "0")}`;
    blob.values.set(`operations/${id}.json`, { id, changes: [] });
  }
  const env = { SESSION_SECRET: secret, LEXI_KV: emptyLegacyStore, LEXI_BLOB: blob };
  const state = await (await tasksRequest({request: await authorizedRequest("GET"), env})).json();
  blob.getCalls = 0;
  const response = await tasksRequest({request: await authorizedRequest("PUT", {
    tasks: [validTask()], expectedUpdatedAt: state.updatedAt,
  }), env});
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).tasks, [validTask()]);
  assert.ok(blob.getCalls < 64);
});

test("history loading bounds simultaneous Blob requests", async () => {
  class ConnectionLimitedStore extends BlobStore {
    active=0;
    maximum=0;
    async get(key) {
      this.active+=1;
      this.maximum=Math.max(this.maximum,this.active);
      try {
        if(this.active>4) throw new Error("too many simultaneous storage requests");
        await new Promise(resolve=>setTimeout(resolve,1));
        return await super.get(key);
      } finally {this.active-=1;}
    }
  }
  const blob=new ConnectionLimitedStore();
  for(let index=0;index<61;index+=1){
    const id=`${Date.now()}_${String(index).padStart(32,"0")}`;
    blob.values.set(`operations/${id}.json`,{id,changes:[]});
  }
  const response=await tasksRequest({request:await authorizedRequest("GET"),
    env:{SESSION_SECRET:secret,LEXI_KV:emptyLegacyStore,LEXI_BLOB:blob}});
  assert.equal(response.status,200);
  assert.ok(blob.maximum<=4);
});

test("maintenance failure does not turn a committed write into a failed save", async () => {
  class MaintenanceFailureStore extends BlobStore {
    async setJSON(key, value, options) {
      if (key.startsWith("snapshots/")) throw new Error("snapshot unavailable");
      return super.setJSON(key, value, options);
    }
  }
  const blob = new MaintenanceFailureStore();
  for (let index = 0; index < 8; index += 1) {
    const id = `${Date.now() - 600000}_${String(index).padStart(32, "0")}`;
    blob.values.set(`operations/${id}.json`, {id, changes: []});
  }
  const env = { SESSION_SECRET: secret, LEXI_KV: emptyLegacyStore, LEXI_BLOB: blob };
  const state = await (await tasksRequest({request: await authorizedRequest("GET"), env})).json();
  const response = await tasksRequest({request: await authorizedRequest("PUT", {
    tasks: [validTask()], expectedUpdatedAt: state.updatedAt,
  }), env});
  assert.equal(response.status, 200);
  const saved = await (await tasksRequest({request: await authorizedRequest("GET"),env})).json();
  assert.deepEqual(saved.tasks, [validTask()]);
});

test("a stale device cannot reinsert a deleted task even with the current version", async () => {
  const blob = new BlobStore();
  const env = {SESSION_SECRET: secret, LEXI_KV: emptyLegacyStore, LEXI_BLOB: blob};
  const added = await (await tasksRequest({request:await authorizedRequest("PUT", {
    tasks:[validTask()],expectedUpdatedAt:null,
  }),env})).json();
  const deleted = await (await tasksRequest({request:await authorizedRequest("PUT", {
    tasks:[],expectedUpdatedAt:added.updatedAt,
  }),env})).json();
  const stale = await tasksRequest({request:await authorizedRequest("PUT", {
    tasks:[validTask()],expectedUpdatedAt:deleted.updatedAt,
  }),env});
  assert.equal(stale.status,200);
  assert.deepEqual((await stale.json()).tasks,[]);
});

test("deletion tombstones survive operation history compaction", async () => {
  const blob = new BlobStore();
  const old = Date.now() - 600000;
  for (let index = 0; index < 8; index += 1) {
    const id = `${old + index}_${String(index).padStart(32, "0")}`;
    const changes = index === 0 ? [{id:"task-1",before:null,after:validTask()}]
      : index === 1 ? [{id:"task-1",before:validTask(),after:null}] : [];
    blob.values.set(`operations/${id}.json`,{id,changes});
  }
  const env = {SESSION_SECRET:secret,LEXI_KV:emptyLegacyStore,LEXI_BLOB:blob};
  const before = await (await tasksRequest({request:await authorizedRequest("GET"),env})).json();
  const added = await (await tasksRequest({request:await authorizedRequest("PUT",{
    tasks:[validTask({id:"task-2"})],expectedUpdatedAt:before.updatedAt,
  }),env})).json();
  assert.ok([...blob.values.keys()].some(key=>key.startsWith("snapshots/")));
  const response = await tasksRequest({request:await authorizedRequest("PUT",{
    tasks:[validTask(),validTask({id:"task-2"})],expectedUpdatedAt:added.updatedAt,
  }),env});
  assert.deepEqual((await response.json()).tasks,[validTask({id:"task-2"})]);
});

test("old clients cannot manufacture new conflict-copy task IDs", async () => {
  const blob = new BlobStore();
  const response = await tasksRequest({request:await authorizedRequest("PUT",{
    tasks:[validTask({project:"排期台（本机冲突副本）"})],expectedUpdatedAt:null,
  }),env:{SESSION_SECRET:secret,LEXI_KV:emptyLegacyStore,LEXI_BLOB:blob}});
  assert.equal(response.status,409);
  assert.equal((await response.json()).code,"LEGACY_CLIENT");
  assert.equal(blob.values.size,0);
});

test("cleanup rejects stale clients even after they learn the latest state version",async()=>{
  const blob=new BlobStore();
  const env={SESSION_SECRET:secret,LEXI_KV:emptyLegacyStore,LEXI_BLOB:blob};
  const added=await(await tasksRequest({request:await authorizedRequest("PUT",{
    tasks:[validTask()],expectedUpdatedAt:null,
  }),env})).json();
  const cleaned=await(await tasksRequest({request:await authorizedRequest("PUT",{
    tasks:[],expectedUpdatedAt:added.updatedAt,clientVersion:2,repairEpoch:null,cleanupEpoch:"cleanup-test",
  }),env})).json();
  assert.equal(cleaned.repairEpoch,"cleanup-test");
  const stale=await tasksRequest({request:await authorizedRequest("PUT",{
    tasks:[],expectedUpdatedAt:cleaned.updatedAt,
  }),env});
  assert.equal(stale.status,409);
  assert.equal((await stale.json()).code,"RELOAD_REQUIRED");
  const current=await tasksRequest({request:await authorizedRequest("PUT",{
    tasks:[],expectedUpdatedAt:cleaned.updatedAt,clientVersion:2,repairEpoch:"cleanup-test",
  }),env});
  assert.equal(current.status,200);
});

test("an explicit cleanup can restore a backed-up keeper without reopening stale client writes",async()=>{
  const blob=new BlobStore();
  const env={SESSION_SECRET:secret,LEXI_KV:emptyLegacyStore,LEXI_BLOB:blob};
  const added=await(await tasksRequest({request:await authorizedRequest("PUT",{
    tasks:[validTask()],expectedUpdatedAt:null,
  }),env})).json();
  const removed=await(await tasksRequest({request:await authorizedRequest("PUT",{
    tasks:[],expectedUpdatedAt:added.updatedAt,
  }),env})).json();
  const invalid=await tasksRequest({request:await authorizedRequest("PUT",{
    tasks:[validTask()],expectedUpdatedAt:removed.updatedAt,restoredIds:["task-1"],
  }),env});
  assert.equal(invalid.status,400);
  const restored=await tasksRequest({request:await authorizedRequest("PUT",{
    tasks:[validTask()],expectedUpdatedAt:removed.updatedAt,clientVersion:2,
    cleanupEpoch:"approved-cleanup",restoredIds:["task-1"],
  }),env});
  assert.equal(restored.status,200);
  assert.deepEqual((await restored.json()).tasks,[validTask()]);
  const state=await(await tasksRequest({request:await authorizedRequest("GET"),env})).json();
  assert.deepEqual(state.tasks,[validTask()]);
});

test("task writes reject impossible calendar dates", async () => {
  const response = await tasksRequest({
    request: await authorizedRequest("PUT", {
      tasks: [validTask({ startDate: "2026-02-30" })],
      expectedUpdatedAt: null,
    }),
    env: { SESSION_SECRET: secret, LEXI_KV: emptyLegacyStore, LEXI_BLOB: new BlobStore() },
  });
  assert.equal(response.status, 400);
});

test("login throttles repeated failures", async () => {
  const authBlob = new BlobStore();
  const env = { WEB_PASSWORD: "correct", SESSION_SECRET: secret, LEXI_AUTH_BLOB: authBlob };
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await loginRequest({
      request: new Request("https://example.com/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "192.0.2.1",
          "user-agent": `rotating-agent-${attempt}`,
        },
        body: "password=wrong",
      }),
      env,
    });
    assert.equal(response.status, attempt <= 5 ? 401 : 429);
  }
  assert.equal(authBlob.values.size, 6);
});

test("EdgeOne serves login assets without a session", async () => {
  let continued = false;
  const response = await middleware({
    request: new Request("https://example.com/avatar.png"),
    env: { WEB_PASSWORD: "password", SESSION_SECRET: secret },
    next() {
      continued = true;
      return new Response("asset");
    },
  });
  assert.equal(continued, true);
  assert.equal(response.status, 200);
});

test("the current page and offline bootstrap replace the disposable starter", async () => {
  const [page, layout, bootstrap, packageJson, legacyApp, pixelBlast] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("public/legacy/auth-bootstrap.js", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("public/legacy/app.js", root), "utf8"),
    readFile(new URL("app/components/PixelBlast.jsx", root), "utf8"),
  ]);

  assert.match(page, /<LegacyHome \/>/);
  assert.match(layout, /Lexi's workday/);
  assert.match(bootstrap, /showPage\(\);\s*throw error;/);
  assert.match(legacyApp, /mergeConcurrentChanges\(syncLocalBase, tasks, remote.tasks\)/);
  assert.match(legacyApp, /hasUnsyncedChanges\(\)/);
  assert.match(legacyApp, /const byProject = new Map\(\)/);
  assert.match(pixelBlast, /IntersectionObserver/);
  assert.match(pixelBlast, /forceContextLoss\(\)/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(packageJson, /"@edgeone\/pages-blob": "0\.0\.18"/);
  await assert.rejects(readFile(new URL("app\/_sites-preview\/SkeletonPreview.tsx", root)));
});
