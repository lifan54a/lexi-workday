import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createSessionToken,
  isSessionTokenValid,
  loginPage,
} from "../edgeone/edge-functions/login.js";
import { onRequest as tasksRequest } from "../edgeone/edge-functions/api/tasks.js";

const root = new URL("../", import.meta.url);
const secret = "test-session-secret";

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
  let stored = null;
  const store = {
    async get() { return stored; },
    async put(_key, value) { stored = value; },
  };
  const env = { SESSION_SECRET: secret, LEXI_KV: store };

  const first = await tasksRequest({
    request: await authorizedRequest("PUT", { tasks: [validTask()], expectedUpdatedAt: null }),
    env,
  });
  assert.equal(first.status, 200);
  const firstState = JSON.parse(stored);

  const stale = await tasksRequest({
    request: await authorizedRequest("PUT", {
      tasks: [validTask({ project: "被覆盖的版本" })],
      expectedUpdatedAt: null,
    }),
    env,
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(JSON.parse(stored), firstState);
});

test("task writes reject executable document links", async () => {
  const store = { async get() { return null; }, async put() {} };
  const response = await tasksRequest({
    request: await authorizedRequest("PUT", {
      tasks: [validTask({ reqDoc: "javascript:alert(1)" })],
      expectedUpdatedAt: null,
    }),
    env: { SESSION_SECRET: secret, LEXI_KV: store },
  });
  assert.equal(response.status, 400);
});

test("the current page and offline bootstrap replace the disposable starter", async () => {
  const [page, layout, bootstrap, packageJson] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("public/legacy/auth-bootstrap.js", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(page, /<LegacyHome \/>/);
  assert.match(layout, /Lexi's workday/);
  assert.match(bootstrap, /showPage\(\);\s*throw error;/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(readFile(new URL("app\/_sites-preview\/SkeletonPreview.tsx", root)));
});
