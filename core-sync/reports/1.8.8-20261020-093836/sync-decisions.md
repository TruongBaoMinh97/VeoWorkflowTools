# Veo3Studio 1.8.8 successful image-path trace

- Trace source: installed Veo3Studio `1.8.8`
- Previous baseline: `1.8.5`
- Successful run: 2026-10-20 16:36:39-16:36:53 (Asia/Saigon)
- VeoWorkflow branch: `codex/sync-captcha-1.8.8`
- Apply mode: source-first; no package, installer, release, or installed-runtime copy

## Runtime evidence

- Veo3Studio created one `HARBOR_SEAL` landscape image for profile `m`.
- The Electron CAPTCHA bridge handled `/captcha/mint`; token acquisition completed in 398 ms.
- `Veo3Service` submitted one image request and mapped all `1/1` returned images.
- The successful path completed at 16:36:53 without retry.

## Applied or already synchronized

| Runtime component | Decision | VeoWorkflow source |
| --- | --- | --- |
| `veo3Service.js` default request headers | Applied | `full-source-app/apps/server/src/services/veo3/veo3Service.js` now derives UA, `sec-ch-ua`, and platform from the detected host Chrome instead of macOS Chrome 131. |
| `flowBoq.js` bootstrap/RPC UA | Applied | `full-source-app/apps/server/src/lib/flowBoq.js` now uses the same host Chrome UA. |
| `veo3HttpClient.js` submit normalization | Already synchronized | Existing 1.8.8 adaptation rewrites the submit fingerprint using the detected Chrome major. |
| `hostChromeUa.js` | Already synchronized | Central source for host UA and Client Hints. |
| `captchaProvider.js`, Electron bridge lifecycle, frame-aware mint | Already synchronized | Existing source-first 1.8.8 adaptations retained. |

## Loaded but unchanged for this successful path

- `captchaManager.js`, `sessionIdManager.js`, `tlsClient.js`, `genNormalQueueManager.js`, `GenNormalJobHandler.js`, and `GenNormalStatusPoller.js` differ from 1.8.5 only by generated source-map footer in the audited candidate.
- `genNormal.routes.js` adds an unrelated `upscaleSerial` setting; it did not affect this one-image request and was not copied.
- Electron `main.js` contains broad packaging, security, updater, and product changes and was not copied wholesale.

## Intentional exclusion

- The upstream `evaluateOnNewDocument` patch that suppresses Google anti-abuse/hijack detection remains excluded. This synchronization does not automate CAPTCHA circumvention.

## Verification

- Focused CAPTCHA/Flow architecture tests: `11/11` passed.
- `npm run typecheck`: passed.
- `npm run build`: passed for server and renderer.
- Built `Veo3Service` resolves Chrome `155.0.8059.85`, Windows UA, Chrome 155 Client Hints, and `"Windows"` platform when supplied the detected host values.
- No live VeoWorkflow generation was started; the successful production evidence came from the user's Veo3Studio run, and Veo3Studio still owned port 4000 during verification.

## Baseline and rollback

- Baseline is not promoted because the intentionally excluded CAPTCHA anti-abuse patch remains a relevant 1.8.8 delta.
- No extra backup was created. Git commits on the dedicated branch provide rollback while preserving unrelated working-tree changes.
