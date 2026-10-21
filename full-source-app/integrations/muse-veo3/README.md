# Muse: optional Veo3 image provider

Source adapter for the local Muse host at `D:/muse-superveo-extracted`.
The original Muse provider remains the default. No original bundle is edited.

## Usage

1. Keep VeoWorkflow running (backend `http://127.0.0.1:4000`).
2. In Muse choose **Text → Ảnh**, then **Bộ tạo ảnh → Veo3 Gen**.
3. Load the project list and choose a project with logged-in Google profiles.
4. Enter one prompt per line and click **Tạo ảnh bằng Veo3**.

The existing run button and Ctrl/Cmd+Enter also route to Veo3 when selected.
Reference mapping uses Muse's shared/paired and `[#1,2]` syntax, with a limit of
10 references per prompt. Landscape/portrait map to 16:9/9:16. Results appear
as local Muse jobs labeled `Veo3 · <profile name>`. Use **Dừng job Veo3** for
remote cancellation. Retry is routed by the local Muse host retry hook.

Each submission creates an isolated Veo3 Gen project, using the selected
project's profiles and image model. Existing drafts are never started or
cleared. Cookies/tokens stay in VeoWorkflow and are not copied into Muse.
Remote jobs are reconciled after reload. Network failures are not automatically
resubmitted, to avoid duplicate paid generation; partial failures include the
remote project ID for inspection before manual resubmission.

## Local host wiring

The existing local Muse source host is wired as follows:

- `electron/main.mjs` imports `MuseVeo3Bridge` from this folder; command
  `muse_veo3` calls `bridge.invoke(payload)`.
- Its asset protocol serves this folder's `client.js` at
  `muse://app/veo3-integration/client.js` with JavaScript MIME and no-store.
- `index.html` includes that module after the existing host module.
- `pool-ui.js` renders the provider/profile label for Veo3 jobs.
- `muse-runtime-patch.mjs` calls `window.__MUSE_RETRY_VEO3__` before the normal
  Muse retry function. Existing Muse retry behavior remains the fallback.

These loader hooks are machine-local, outside this repository. Restoring only
this Git branch onto another machine does not install the Muse host hooks.
No package, release, new app copy, installer, or shortcut is produced.

## Verification

- Root `npm test` includes `museVeo3Bridge.test.js`: isolated batches, reference
  upload mapping, job order, invalid input, lock release, no automatic retries.
- Root `npm run typecheck` validates existing backend and renderer source.
- Run `smoke.cjs` using the Muse Electron executable to exercise the actual
  renderer with a separate non-persistent session and mocked generation.
  All HTTP requests are blocked in that test; it spends no generation credits.
- Real image generation speed and paid generation success require a live job;
  mock tests do not establish either.
