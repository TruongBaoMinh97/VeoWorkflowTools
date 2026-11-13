# Veo3Studio 1.9.8 → VeoWorkflow source sync

- Installed candidate: `1.9.8-20261113-145356`; audit baseline: `1.8.5-20260929-190321`.
- The baseline pointer is older than the source: commit `2b1c3cf` already ported the 1.9.8 image/video core, and `65bdc23` plus `b44f0f8` updated the browser integration. The 11 November and 13 November 1.9.8 candidate manifests contain identical tracked file hashes.
- The only upstream file changed since the initial 9 November 1.9.8 snapshot is Electron `ipcBridge.js`: it now assigns `process.env.LOCAL_AUTH_SECRET` during bridge startup. VeoWorkflow's existing Electron `main.js` already sets that environment value before starting its backend. Decision: ignore as redundant. The editable Electron IPC source is absent in this checkout; no compiled bundle was modified.

## Applied source adaptation

| Area | Decision | Target and reason |
| --- | --- | --- |
| Veo3 Gen image admission | Adapt | The shared `profileImageScheduler.js` retains its 2-request/5-second default for workflow callers. Veo3 Gen alone passes its existing 12-request pipeline limit and 1-second gap (2 seconds for reference images) through `genNormalQueueManager.js` and `veo3Service.js`. Preserve verification blocking and traffic cooldown. |
| Flow image 429 classification | Adapt | `flowImageGen.js` previously replaced a gRPC `RESOURCE_EXHAUSTED` error with a generic message and lost its status and quota reason. Preserve the 429/traffic flag so Gen Normal uses its longer backoff; preserve a daily quota reason so the queue stops retrying an exhausted model. |
| Image/video provider contracts, profile sessions, CAPTCHA browser | Already applied or intentionally local | Existing 1.9.8 source changes and subsequent browser work remain in place. VeoWorkflow keeps its profile-bound token request and user verification stop on explicit 403. Upstream proxy-triggered CAPTCHA reset was not imported; if proxy egress changes while a browser session is open, that remains a conditional integration risk to diagnose from live logs. No upstream queue, IPC, extension, authentication, updater, schema, renderer bundle, or workflow batch logic was copied. |

## Verification and delivery

- Focused Gen Normal, Flow 429, CAPTCHA classification, scheduler and regression tests passed (53 tests); `npm run typecheck` passed.
- Full architecture suite: 308 passed, 1 existing Etsy preset assertion failed in `girlsPrincessDressWorkflow.test.js` against unrelated dirty preset content. An earlier parallel run also had a timing-sensitive failure; rerun left only the Etsy failure.
- No live Flow request or packaged app test was run. This update is source-only by repository instruction; the installed VeoWorkflow app is unchanged.
- Rollback: Git commit for the touched source and tests. Existing unrelated working-tree edits were preserved.
- Baseline pointer remains at 1.8.5 because this source-only adaptation does not reconcile every historical audit entry or package the installed runtime.
