# EdgeOne deployment

This directory is the existing EdgeOne project's Git build root. Production is deployed from the repository's `main` branch. `build.mjs` copies the shared frontend in `../public/legacy/` to `dist/`.

## Storage and runtimes

- `cloud-functions/api/tasks.js` owns task reads and writes. Blob operations belong in Cloud Functions, not the edge runtime.
- `cloud-functions/login.js` serves the login page and stores login attempt records in Blob.
- `edge-functions/api/legacy-tasks.js` is an authenticated, read-only bridge to the old `LEXI_KV` binding. Node code must not call the edge-only global binding directly.
- The bridge origin defaults to `https://work.yoube.cloud`. Set `LEXI_PUBLIC_ORIGIN` when using a different deployment or a local development server, because a Cloud Functions request URL can contain an internal platform hostname.
- Blob SDK `0.0.18` is pinned in both package manifests and all lockfiles. Conditional writes use COS overwrite protection. Keep strong consistency enabled.

History reads are limited to four simultaneous Blob requests. A save reuses history already read in the same request, and history maintenance is isolated from the business write. Snapshots preserve deletion tombstones and repair versions.

## Sync and cleanup

The browser atomically caches tasks together with their merge ancestor. Saves process the latest local state and rebase edits made while a request was in flight. Concurrent edits keep one task ID; version conflicts do not manufacture another task.

An explicitly approved cleanup sets `cleanupEpoch` and uses protocol version 2. Once recorded, older clients must refresh before they can save. The new browser code archives the old local cache before adopting the repaired list. Only an explicit cleanup can restore backed-up keeper IDs through `restoredIds`; ordinary stale writes cannot resurrect deleted IDs.

Task backups and cleanup plans contain private data. Keep them outside this repository; do not commit them.

## Verification

Run from the repository root:

```powershell
node --test tests/*.test.mjs
npx eslint public/legacy/app.js edgeone/cloud-functions/api/tasks.js edgeone/cloud-functions/login.js edgeone/edge-functions/api/legacy-tasks.js tests/*.test.mjs
$env:WRANGLER_LOG_PATH = '.wrangler/wrangler.log'
npx vinext build
node edgeone/build.mjs
```

After a deployment, verify the actual response version (`x-lexi-sync-version`), then add and remove a uniquely marked test record with a fresh version precondition. Confirm the deletion with another GET. Do not treat a successful build or a cached response as proof that saving works.
