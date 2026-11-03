import { getStore as getBlobStore } from "@edgeone/pages-blob";

const encoder = new TextEncoder();
const TASKS_KEY = "tasks";
const OPERATION_PREFIX = "operations/";
const SNAPSHOT_PREFIX = "snapshots/";
const COMPACTION_THRESHOLD = 8;
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
  return env?.LEXI_BLOB ?? getBlobStore({ name: "lexi-workday-state", consistency: "strong" });
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
  const canonical = (value) => value && typeof value === "object"
    ? Array.isArray(value) ? value.map(canonical)
      : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
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
      if (change.before === null) merged.set(change.id, change.after);
      continue;
    }
    // Merge fields of the same record instead of manufacturing a new task ID.
    const combined = { ...current };
    for (const field of Object.keys(change.after)) {
      if (!sameTask(change.after[field], change.before?.[field])) combined[field] = change.after[field];
    }
    merged.set(change.id, combined);
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

async function readState(env, previous = null) {
  const legacyStore = getLegacyStore(env);
  const legacy = previous?.legacy ?? parseLegacyState(legacyStore ? await legacyStore.get(TASKS_KEY) : null);
  const stateStore = getStateStore(env);
  const snapshotKeys = await listKeys(stateStore, SNAPSHOT_PREFIX);
  const snapshots = await Promise.all(snapshotKeys.map(async (key) => ({
    key,
    value: previous?.snapshotValues?.get(key) ?? await stateStore.get(key, { type: "json", consistency: "strong" }),
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
  const previousOperations = new Map(previous?.operations?.map((operation) => [operation.key, operation.value]) ?? []);
  const operations = await Promise.all(operationKeys.map(async (key) => ({
    key,
    value: previousOperations.get(key) ?? await stateStore.get(key, { type: "json", consistency: "strong" }),
  })));
  const deletedIds = new Set(latestSnapshot?.value.deletedIds ?? []);
  for (const operation of operations) {
    for (const change of operation.value.changes) if (change.after === null) deletedIds.add(change.id);
  }
  const tasks = operations.reduce((current, operation) => applyOperation(current, operation.value), baseTasks)
    .filter((task) => !deletedIds.has(task.id));
  if (!areValidTasks(tasks, true)) throw new Error("materialized task data is invalid");
  const versionSeed = latestSnapshot ? `snapshot:${latestSnapshot.key}` : legacy.updatedAt;
  return {
    tasks,
    deletedIds,
    legacy,
    snapshotValues: new Map(snapshots.map((snapshot) => [snapshot.key, snapshot.value])),
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
    // Bound maintenance work per request; an unbounded delete burst can exhaust
    // the edge runtime's subrequest budget after the business write committed.
    await Promise.all([...coveredKeys, ...oldSnapshots].slice(0, 8).map((key) => current.stateStore.delete(key)));
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
  const deletedIds = new Set(current.latestSnapshot?.value.deletedIds ?? []);
  for (const operation of compactable) {
    for (const change of operation.value.changes) if (change.after === null) deletedIds.add(change.id);
  }
  const snapshotKey = `${SNAPSHOT_PREFIX}${String(now).padStart(13, "0")}_${crypto.randomUUID().replaceAll("-", "")}.json`;
  await current.stateStore.setJSON(
    snapshotKey,
    { tasks: tasks.filter((task) => !deletedIds.has(task.id)), deletedIds: [...deletedIds], throughKey, createdAt: now },
    { onlyIfNew: true },
  );
  return true;
}

export async function onRequest({ request, env }) {
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  const requestId = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
  let stage = "authorize";
  try {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "unauthorized" }, 401);
  }

  if (request.method === "GET") {
    try {
      const { tasks, updatedAt } = await readState(env);
      return json({ tasks, updatedAt });
    } catch (error) {
      console.error("Task read failed", { requestId, code: error?.code, message: error?.message });
      return json({ error: "task read failed", code: "READ_FAILED", requestId }, 503);
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

    const currentIds = new Set(current.tasks.map((task) => task.id));
    if (body.tasks.some((task) => !currentIds.has(task.id) && !current.deletedIds.has(task.id)
      && /（(?:本机|并发)冲突副本）/.test(task.project))) {
      return json({ error: "refresh required", code: "LEGACY_CLIENT", tasks: current.tasks, updatedAt: current.updatedAt }, 409);
    }

    // Old tabs/devices can upload records which were deliberately removed.
    // Persist deletion tombstones through compaction so they cannot resurrect.
    const desiredTasks = body.tasks.filter((task) => !current.deletedIds.has(task.id));
    const changes = taskChanges(current.tasks, desiredTasks);
    if (changes.length === 0) return json({ ok: true, tasks: current.tasks, updatedAt: current.updatedAt });

    const previousKey = current.operationKeys.at(-1) ?? current.latestSnapshot?.value.throughKey;
    const timestamp = Math.max(Date.now(), previousKey ? operationTimestamp(previousKey) + 1 : 0);
    const operationId = `${String(timestamp).padStart(13, "0")}_${requestId}`;
    const operationKey = `${OPERATION_PREFIX}${operationId}.json`;
    stage = "write";
    await current.stateStore.setJSON(
      operationKey,
      { id: operationId, changes },
      { onlyIfNew: true },
    );
    // Reuse already-read history. Reading every operation a second time can
    // exceed the edge subrequest limit while GET still works normally.
    stage = "read-after-write";
    let finalState = await readState(env, current);
    try {
      if (await compactState(finalState)) finalState = await readState(env, finalState);
    } catch (error) {
      console.error("Task history maintenance failed", { requestId, code: error?.code, message: error?.message });
    }
    return json({ ok: true, tasks: finalState.tasks, updatedAt: finalState.updatedAt });
  }

  return json({ error: "method not allowed" }, 405, { allow: "GET, PUT" });
  } catch (error) {
    console.error("Task sync failed", { requestId, stage, code: error?.code, message: error?.message });
    return json({ error: "task sync failed", code: "SYNC_FAILED", stage, requestId }, 503);
  }
}
