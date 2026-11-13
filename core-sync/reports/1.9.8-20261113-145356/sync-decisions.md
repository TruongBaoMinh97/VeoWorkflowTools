# Veo3Studio 1.9.8 → VeoWorkflow source sync

- Installed candidate: `1.9.8-20261113-145356`; audit baseline: `1.8.5-20260929-190321`.
- The baseline pointer is older than the source: commit `2b1c3cf` already ported the 1.9.8 image/video core, and `65bdc23` plus `b44f0f8` updated the browser integration. The 11 November and 13 November 1.9.8 candidate manifests contain identical tracked file hashes.
- The only upstream file changed since the initial 9 November 1.9.8 snapshot is Electron `ipcBridge.js`: it now assigns `process.env.LOCAL_AUTH_SECRET` during bridge startup. VeoWorkflow's existing Electron `main.js` already sets that environment value before starting its backend. Decision: ignore as redundant. The editable Electron IPC source is absent in this checkout; no compiled bundle was modified.

## Applied source adaptation

| Area | Decision | Target and reason |
| --- | --- | --- |
| Profile image admission | Adapt | `apps/server/src/lib/profileImageScheduler.js`: the shared gate had limited all image callers to 2 in-flight requests and 5 seconds between admissions, while Studio 1.9.8's image pipeline uses a 12-request cap and 1-second minimum reCAPTCHA gap. Set the default to 12 and 1 second. Preserve verification blocking and traffic cooldown. |
| Workflow advanced image batch | Adapt | `apps/server/src/modules/workflow/lib/imageGenerationQueue.js` and `workflow.batch.orchestrator.js`: allow up to 12 images per profile, including three overlapping four-image requests, when parallel settings are enabled. Keep the ordinary workflow queue's existing 8-image limit and its separate orchestration. |
| Image/video provider contracts, profile sessions, CAPTCHA browser | Already applied | Existing 1.9.8 source changes and subsequent browser work remain in place. No wholesale upstream queue, IPC, extension, authentication, updater, schema, or renderer bundle was copied. |

## Verification and delivery

- Focused image queue and scheduler tests passed; `npm run typecheck` passed.
- Full architecture suite: 308 passed, 1 existing Etsy preset assertion failed in `girlsPrincessDressWorkflow.test.js` against unrelated dirty preset content. An earlier parallel run also had a timing-sensitive failure; rerun left only the Etsy failure.
- No live Flow request or packaged app test was run. This update is source-only by repository instruction; the installed VeoWorkflow app is unchanged.
- Rollback: Git commit for the touched source and tests. Existing unrelated working-tree edits were preserved.
- Baseline pointer remains at 1.8.5 because this source-only adaptation does not reconcile every historical audit entry or package the installed runtime.
