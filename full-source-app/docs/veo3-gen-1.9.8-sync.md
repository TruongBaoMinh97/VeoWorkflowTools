# Veo3Studio 1.9.8 generation core in VeoWorkflow

Source audited: installed Veo3Studio 1.9.8, snapshot
`core-sync/snapshots/1.9.8-20261109-044904`. The installed
`resources/server/dist/services/veo3/veo3Service.js` still matched the
snapshot SHA-256 when this work began. The core-sync comparison baseline is
1.8.5; it was not promoted by this source change.

## Decisions

| Area | Decision | Source target and integration |
| --- | --- | --- |
| Image/video generation, video batch RPC, media status | Adopt and adapt | `apps/server/src/services/veo3`; keep VeoWorkflow's public service methods and queue result shape. Batch video uses one token for up to four compatible rows and reports unaccepted rows for requeue. |
| Flow model catalogue, Omni 1.2, 360p, model retirement | Adopt and adapt | `apps/server/src/lib/modelCatalog.js`, `services/modelCatalogService.js`, `utils/liveVideoModels.js`, `utils/videoModelResolver.js`, `modules/genNormal/genNormal.routes.js`, `server.js`. Use VeoWorkflow user data for the cache and select active local profiles because this schema has no `profileType`. |
| Gen Normal and workflow model mapping | Adapt | Pass the stored Omni key to the new resolver in `genNormalQueueManager.js` and `workflow.engine.js`; otherwise Omni 1.2 silently resolves as Omni 1.1. Accept 3–15 second durations at the API boundary; the resolver enforces each family's supported set. |
| CAPTCHA token minting | Adapt | Keep `captchaManager.requestToken(action, profileId)` in `veo3Service.js` so tokens are minted in the selected VeoWorkflow profile. Preserve the existing user verification and model access error categories in `flowImageGen.js`, `veo3ErrorHandler.js`, and the service's auth refresh path. |
| Proxy rotation | Adapt | Add `proxyGate.js`; switch the local proxy only after in-flight mint-and-submit units drain, then clear cached Flow sessions. Keep VeoWorkflow's current proxy provider configuration and queue policy. |
| Image partial retry, upscale, prompt expansion | Adapt | Keep `completedImages` across batch retry to avoid charging twice for an accepted image; keep cookie-authenticated BOQ image upscale without a legacy Bearer requirement; retain the local expanded-prompt method used by the product. |
| Google Vids, alternate CAPTCHA browser, authentication, updater, Electron and renderer bundles | Exclude | These are outside the requested Veo3 generation module or lack editable source in this checkout. No built bundle or installed app was edited. |

Upstream file status labels are hash based and were not used as proof of API
compatibility. Removed upstream files such as `flowTelemetryBuffer.js` and
`veo3TokenService.js` remain in VeoWorkflow where local callers or contracts
still depend on them.

## Verification

- `npm run typecheck`: passed.
- Focused generation contract tests: passed.
- `npm run build`: passed.
- `npm test`: 298 passed, one existing failure in
  `girlsPrincessDressWorkflow.test.js` caused by unrelated dirty Etsy preset
  source that this branch did not modify.
- No live Flow generation or packaged desktop test was run. Source changes
  are for development and review; packaging/release requires a separate user
  request.

Rollback is through Git on this branch. No extra source backup was created.
