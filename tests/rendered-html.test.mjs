import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createSessionToken,
  isSessionTokenValid,
  loginPage,
  onRequest as loginRequest,
} from "../edgeone/edge-functions/login.js";
import { onRequest as tasksRequest } from "../edgeone/edge-functions/api/tasks.js";
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
  assert.match(legacyApp, /mergeConcurrentChanges\(syncLocalBase, snapshot, syncedTasks\)/);
  assert.match(legacyApp, /hasUnsyncedChanges\(\)/);
  assert.match(legacyApp, /const byProject = new Map\(\)/);
  assert.match(pixelBlast, /IntersectionObserver/);
  assert.match(pixelBlast, /forceContextLoss\(\)/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(packageJson, /"@edgeone\/pages-blob": "0\.0\.16"/);
  await assert.rejects(readFile(new URL("app\/_sites-preview\/SkeletonPreview.tsx", root)));
});
