import { getStore as getBlobStore } from "@edgeone/pages-blob";

const encoder = new TextEncoder();
const TASKS_KEY = "tasks";
const OPERATION_PREFIX = "operations/";
const SNAPSHOT_PREFIX = "snapshots/";
const COMPACTION_THRESHOLD = 100;
const COMPACTION_GRACE_MS = 5 * 60 * 1000;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_TOKEN_PURPOSE = "lexi-workday-edgeone-authorized";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const URGENCIES = new Set(["high", "medium", "low"]);

function getLegacyStore(env) {
  if (typeof LEXI_KV !== "undefined") return LEXI_KV;
  return env?.LEXI_KV;
}

function getStateStore(env) {
  return env?.LEXI_BLOB ?? getBlobStore("lexi-workday-state");
}

async function createSessionToken(secret, expiresAt) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${SESSION_TOKEN_PURPOSE}:${expiresAt}`),
  );
  const encodedSignature = Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${expiresAt}.${encodedSignature}`;
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

async function isAuthorized(request, env) {
  if (!env?.SESSION_SECRET) return false;
  const cookie = request.headers.get("cookie") ?? "";
  const actual = cookie.match(/(?:^|;\s*)lexi_session=([^;]+)/)?.[1] ?? "";
  const separator = actual.indexOf(".");
  if (separator <= 0) return false;
  const expiresAt = Number(actual.slice(0, separator));
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= nowSeconds ||
    expiresAt > nowSeconds + SESSION_TTL_SECONDS + 60
  ) return false;
  return safeEqual(actual, await createSessionToken(env.SESSION_SECRET, expiresAt));
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function isSafeLink(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isISODate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function isValidTask(task, allowUnsafeLinks = false) {
  if (!task || typeof task !== "object") return false;
  const startDate = task.startDate ?? task.date;
  return typeof task.id === "string" && task.id.length > 0 && task.id.length <= 128
    && typeof task.project === "string" && task.project.trim().length > 0 && task.project.length <= 60
    && typeof task.urgency === "string" && URGENCIES.has(task.urgency)
    && typeof task.hours === "number" && Number.isFinite(task.hours) && task.hours >= 0 && task.hours <= 24
    && typeof task.progress === "number" && Number.isInteger(task.progress) && task.progress >= 0 && task.progress <= 100
    && isISODate(startDate)
    && (task.duration === undefined || (typeof task.duration === "number" && Number.isInteger(task.duration) && task.duration >= 1 && task.duration <= 365))
    && (task.reviewDate === undefined || task.reviewDate === "" || isISODate(task.reviewDate))
    && (task.notes === undefined || (typeof task.notes === "string" && task.notes.length <= 300))
    && (task.reqDoc === undefined || (typeof task.reqDoc === "string" && task.reqDoc.length <= 500 && (allowUnsafeLinks || isSafeLink(task.reqDoc))))
    && (task.createdAt === undefined || (typeof task.createdAt === "number" && Number.isFinite(task.createdAt)));
}

function areValidTasks(tasks, allowUnsafeLinks = false) {
  return Array.isArray(tasks) && tasks.length <= 5000
    && tasks.every((task) => isValidTask(task, allowUnsafeLinks));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sameTask(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function taskChanges(beforeTasks, afterTasks) {
  const before = new Map(beforeTasks.map((task) => [task.id, task]));
  const after = new Map(afterTasks.map((task) => [task.id, task]));
  return Array.from(new Set([...before.keys(), ...after.keys()]))
    .filter((id) => !sameTask(before.get(id), after.get(id)))
    .map((id) => ({
      id,
      before: clone(before.get(id)) ?? null,
      after: clone(after.get(id)) ?? null,
    }));
}

function applyOperation(tasks, operation) {
  if (!operation || typeof operation !== "object" || !Array.isArray(operation.changes)) {
    throw new Error("stored operation is invalid");
  }
  const merged = new Map(tasks.map((task) => [task.id, task]));
  for (const change of operation.changes) {
    if (!change || typeof change.id !== "string") throw new Error("stored operation is invalid");
    if (change.before !== null && !isValidTask(change.before, true)) throw new Error("stored operation is invalid");
    if (change.after !== null && !isValidTask(change.after, true)) throw new Error("stored operation is invalid");
    const current = merged.get(change.id);
    if (sameTask(current, change.before ?? undefined)) {
      if (change.after) merged.set(change.id, change.after);
      else merged.delete(change.id);
      continue;
    }
    if (sameTask(current, change.after ?? undefined) || !change.after) continue;
    if (!current) {
      merged.set(change.id, change.after);
      continue;
    }
    const conflictId = `${change.id.slice(0, 72)}_conflict_${operation.id.slice(-32)}`;
    merged.set(conflictId, {
      ...change.after,
      id: conflictId,
      project: `${change.after.project}（并发冲突副本）`.slice(0, 60),
    });
  }
  return Array.from(merged.values());
}

function parseLegacyState(raw) {
  if (!raw) return { tasks: [], updatedAt: null };
  const state = JSON.parse(raw);
  if (!state || !areValidTasks(state.tasks, true) || (state.updatedAt !== null && typeof state.updatedAt !== "string")) {
    throw new Error("stored task data is invalid");
  }
  return state;
}

async function listKeys(store, prefix) {
  const result = await store.list({ prefix, consistency: "strong" });
  const entries = result.blobs ?? result.keys ?? [];
  return entries.map((entry) => entry.key).sort();
}

async function stateVersion(legacyVersion, operationKeys) {
  if (operationKeys.length === 0) return legacyVersion;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${legacyVersion ?? "empty"}|${operationKeys.join("|")}`),
  );
  return `ops-${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("")}`;
}

async function readState(env) {
  const legacyStore = getLegacyStore(env);
  const legacy = parseLegacyState(legacyStore ? await legacyStore.get(TASKS_KEY) : null);
  const stateStore = getStateStore(env);
  const snapshotKeys = await listKeys(stateStore, SNAPSHOT_PREFIX);
  const snapshots = await Promise.all(snapshotKeys.map(async (key) => ({
    key,
    value: await stateStore.get(key, { type: "json", consistency: "strong" }),
  })));
  for (const snapshot of snapshots) {
    const value = snapshot.value;
    if (!value || !areValidTasks(value.tasks, true) || typeof value.throughKey !== "string"
      || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
      throw new Error("stored snapshot is invalid");
    }
  }
  const latestSnapshot = snapshots.sort((left, right) =>
    left.value.throughKey.localeCompare(right.value.throughKey) || left.key.localeCompare(right.key)).at(-1) ?? null;
  const baseTasks = latestSnapshot ? latestSnapshot.value.tasks : legacy.tasks;
  const throughKey = latestSnapshot?.value.throughKey ?? "";
  const allOperationKeys = await listKeys(stateStore, OPERATION_PREFIX);
  const operationKeys = allOperationKeys.filter((key) => key > throughKey);
  const operations = await Promise.all(operationKeys.map(async (key) => ({
    key,
    value: await stateStore.get(key, { type: "json", consistency: "strong" }),
  })));
  const tasks = operations.reduce((current, operation) => applyOperation(current, operation.value), baseTasks);
  if (!areValidTasks(tasks, true)) throw new Error("materialized task data is invalid");
  const versionSeed = latestSnapshot ? `snapshot:${latestSnapshot.key}` : legacy.updatedAt;
  return {
    tasks,
    updatedAt: await stateVersion(versionSeed, operationKeys),
    baseTasks,
    latestSnapshot,
    snapshotKeys,
    allOperationKeys,
    operations,
    operationKeys,
    stateStore,
  };
}

function operationTimestamp(key) {
  const value = Number(key.slice(OPERATION_PREFIX.length, OPERATION_PREFIX.length + 13));
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

async function compactState(current) {
  const now = Date.now();
  const stableSnapshot = current.latestSnapshot
    && current.latestSnapshot.value.createdAt <= now - COMPACTION_GRACE_MS;
  if (stableSnapshot) {
    const coveredKeys = current.allOperationKeys.filter((key) =>
      key <= current.latestSnapshot.value.throughKey);
    const oldSnapshots = current.snapshotKeys.filter((key) => key !== current.latestSnapshot.key);
    await Promise.all([...coveredKeys, ...oldSnapshots].map((key) => current.stateStore.delete(key)));
  }

  if (current.operationKeys.length < COMPACTION_THRESHOLD) return false;
  const cutoff = now - COMPACTION_GRACE_MS;
  const compactable = current.operations.filter((operation) => operationTimestamp(operation.key) <= cutoff);
  if (compactable.length === 0) return false;

  const tasks = compactable.reduce(
    (materialized, operation) => applyOperation(materialized, operation.value),
    current.baseTasks,
  );
  const throughKey = compactable.at(-1).key;
  const snapshotKey = `${SNAPSHOT_PREFIX}${String(now).padStart(13, "0")}_${crypto.randomUUID().replaceAll("-", "")}.json`;
  await current.stateStore.setJSON(
    snapshotKey,
    { tasks, throughKey, createdAt: now },
    { onlyIfNew: true },
  );
  return true;
}

export async function onRequest({ request, env }) {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "unauthorized" }, 401);
  }

  if (request.method === "GET") {
    try {
      const { tasks, updatedAt } = await readState(env);
      return json({ tasks, updatedAt });
    } catch {
      return json({ error: "stored task data is invalid" }, 500);
    }
  }

  if (request.method === "PUT") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "request body must be valid JSON" }, 400);
    }
    if (!areValidTasks(body.tasks)) {
      return json({ error: "tasks contain invalid data" }, 400);
    }
    if (!(body.expectedUpdatedAt === null || typeof body.expectedUpdatedAt === "string")) {
      return json({ error: "expectedUpdatedAt is required" }, 428);
    }

    let current;
    try {
      current = await readState(env);
    } catch {
      return json({ error: "stored task data is invalid" }, 500);
    }
    if (current.updatedAt !== body.expectedUpdatedAt) {
      return json({ error: "task state changed", tasks: current.tasks, updatedAt: current.updatedAt }, 409);
    }

    const changes = taskChanges(current.tasks, body.tasks);
    if (changes.length === 0) return json({ ok: true, updatedAt: current.updatedAt });

    const operationId = `${String(Date.now()).padStart(13, "0")}_${crypto.randomUUID().replaceAll("-", "")}`;
    const operationKey = `${OPERATION_PREFIX}${operationId}.json`;
    await current.stateStore.setJSON(
      operationKey,
      { id: operationId, changes },
      { onlyIfNew: true },
    );
    let finalState = await readState(env);
    if (await compactState(finalState)) finalState = await readState(env);
    return json({ ok: true, updatedAt: finalState.updatedAt });
  }

  return json({ error: "method not allowed" }, 405, { allow: "GET, PUT" });
}
