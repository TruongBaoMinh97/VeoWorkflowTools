# Veo3Studio 1.9.5: CAPTCHA and 429 source sync

Upstream installed version: 1.9.5. Recorded baseline: 1.8.5; the last stored audit snapshot is 1.8.9. This update is limited to the VeoWorkflowTools backend source and does not promote the broader core baseline.

| Decision | Change | VeoWorkflowTools handling |
| --- | --- | --- |
| Adapt | Bare Flow gRPC 7 / HTTP 403 may be transient. | Retry with a fresh CAPTCHA token; keep explicit model access denial and verification rejection terminal. |
| Adapt | CAPTCHA mint failure differs from a token rejected by Flow. | Classify missing token and bridge errors separately in image batches, video batches, and single submissions; requeue with a bounded retry and increasing delay. Include VeoWorkflow's `CAPTCHA_EMPTY` error. |
| Adopt | CDP reset should not wait for the next mint. | Apply a pending reset behind any active mint; retain the pending reset if Electron fails to apply it. |
| Adopt | Missing `batchError.errorText` must not make a video batch terminal. | Only classify a raw error body when one exists, preserving the retry path for transient 403/429. |
| Defer | New rotating-proxy egress and Electron browser changes. | The active proxy is disabled, and Electron source must be restored before changes to its bundles. |
| Exclude | Upstream's blanket retry of all 403 responses. | Keep VeoWorkflow's explicit model-access and user-verification safeguards. |

The `FLOW_SIGNED_OUT` / `WIZ_global_data` detection is unchanged upstream and is not part of this sync. No installed app, generated runtime, database, or user data is changed. Verification uses `npm run typecheck` and `npm test`; live provider generation is not part of the static verification.
