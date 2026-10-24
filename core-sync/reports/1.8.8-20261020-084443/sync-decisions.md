# Veo3Studio 1.8.8 CAPTCHA sync decisions

- Audit source: installed Veo3Studio `1.8.8`
- Previous baseline: `1.8.5`
- VeoWorkflow branch: `codex/sync-captcha-1.8.8`
- Scope: CAPTCHA provider, local Electron bridge lifecycle, and submit fingerprint alignment
- Apply mode: source-first; no package, installer, or installed-runtime copy. Electron output is generated only by the package build script and is not committed.

## Applied

| Upstream item | VeoWorkflow source | Decision |
| --- | --- | --- |
| `resource/server/dist/lib/captchaProvider.js` | `full-source-app/apps/server/src/lib/captchaProvider.js` | Adapted provider persistence to VeoWorkflow's bridge abstraction; environment override remains highest priority. Added best-effort `/captcha/close`. Omitted an upstream debug-log typo. |
| `resource/server/dist/modules/captcha/captchaBridge.js` | `full-source-app/apps/server/src/modules/captcha/captchaBridge.js` | Close the managed CDP browser asynchronously when the provider changes to `extension`. |
| `resource/server/dist/lib/hostChromeUa.js` | `full-source-app/apps/server/src/lib/hostChromeUa.js` | Added central host Chrome UA and client-hint derivation. |
| `resource/server/dist/services/veo3/veo3HttpClient.js` | `full-source-app/apps/server/src/services/veo3/veo3HttpClient.js` | Uses the central host Chrome UA fallback and shared `sec-ch-ua` builder so mint and submit fingerprints stay aligned. |
| `asar/apps/electron/dist/main/captchaBrowserManager.js`: frame-aware mint | `full-source-app/apps/electron/src/main/captchaBrowserManager.ts` and `captchaFrameMint.ts` | Adapted the 1.8.8 frame scan to use only the `grecaptcha.enterprise.execute` function already provided by Flow. Restored a targeted TypeScript build for this Electron module. |
| Downstream adaptation | `full-source-app/apps/server/src/lib/electronPaths.js` | Corrected the product userData directory from `veo3studio` to `Veo Workflow Tools`, so CAPTCHA provider persistence stays isolated in this app. |
| Regression coverage | `full-source-app/apps/server/tests/architecture/captchaCore188.test.js` and `electronCaptcha188.test.js` | Covers provider persistence/env override, best-effort CDP close, host Chrome UA/client hints, frame selection, action forwarding, and the no-bypass policy. |

## Intentionally excluded or deferred

| Upstream item | Decision | Reason |
| --- | --- | --- |
| `asar/apps/electron/dist/main/captchaBrowserManager.js`: `evaluateOnNewDocument` patch for `extension_hijack_detected`/honeypot behavior | Excluded | This alters remote CAPTCHA anti-abuse detection behavior and is outside the permitted synchronization scope. |
| `resource/server/dist/lib/captchaManager.js` and related queue/error files | No source change | The observed 1.8.8 deltas were generated source-map footer removal only. |
| Veo3Studio auth, security, licensing, updater, telemetry, and integrity changes | Excluded | Outside user-requested CAPTCHA scope and excluded by core-sync policy. |

## Verification

- `npm run typecheck`: passed.
- Focused CAPTCHA tests: passed (`10/10` in the final four-file run).
- `npm run build`: passed for server and renderer.
- Electron CAPTCHA TypeScript build: passed; generated JavaScript passes `node --check`.
- Focused Electron/CAPTCHA tests: passed, including a source guard against anti-abuse patching.
- Source app restarted through `Veo Workflow Story.lnk`; Electron loaded `D:/VeoWorkflowTools/full-source-app`, launched the server child, and opened its managed `captcha-browser` profile.
- User live check at 2026-10-20 16:26-16:27: the restored frame flow minted two 2,468-character tokens from `https://flow.google.com/about`; Google then rejected both generation requests with `403 PUBLIC_ERROR_UNUSUAL_ACTIVITY`. This confirms transport/mint completion but leaves Google's server-side risk decision unresolved.
- `npm test`: CAPTCHA and related tests passed; overall `215/228` passed. Thirteen unrelated tests in the dirty Manga/Audio/CapCut work timed out.

## Baseline and rollback

- Baseline is intentionally not promoted from `1.8.5` to `1.8.8`, because the audit contains unrelated 1.8.8 core changes outside this CAPTCHA-only synchronization scope.
- No extra file backup was created: the touched source is Git-managed and isolated on the branch above. Rollback is by reverting the dedicated commit.
