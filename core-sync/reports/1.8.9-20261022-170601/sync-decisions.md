# Veo3Studio 1.8.9 Flow-auth sync decisions

- Installed candidate: `1.8.9` (`1.8.9-20261022-170601`)
- Previous baseline: `1.8.5` (`1.8.5-20260929-190321`)
- Scope: profile login failure caused by the retired Labs access-token endpoint, plus image/video generation paths that depended on that token.
- Rollback copy: `D:\VeoWorkflowTools\core-sync\backups\1.8.9-flow-auth-20261023`

## Decisions

- **Adopt** Flow BOQ RPC registry and the current cookie-authenticated RPC IDs.
- **Adopt** cookie-authenticated image generation (`ogiZ0b`) and video submit/poll helpers.
- **Adapt** `Veo3Service`: use Flow BOQ for create project, credits, upload, image generation, video generation, video polling and video upscale; preserve VeoWorkflow verification handling and prompt-expansion compatibility.
- **Adapt** image upscale: use cookie-authenticated BOQ first; do not require the retired Bearer token before attempting BOQ. REST fallback remains available only when a cached legacy token exists.
- **Adapt** profile token handling: classify Labs `/fx/api/auth/session` HTTP 410 as `FLOW_AUTH_RETIRED` and back off instead of asking the user to re-login repeatedly.
- **Adapt** Gen Normal project setup and unauthorized recovery: stop refreshing an access token before generation; verify the stored session directly against Flow cookies.
- **Preserve local** workflow orchestration, Manga/Story additions, verification failure policy, renderer behavior, and captcha implementation.
- **Defer** unrelated Veo3Studio 1.8.9 changes, legacy media/project deletion, and broader database/UI/IPC changes. The baseline is not promoted in this partial sync.

## Verification

- `node --check` on changed JavaScript: passed.
- `npm run typecheck`: passed.
- Focused architecture tests: 19/19 passed.
- `npm run build`: passed.
- Full architecture suite: 268/269 passed; the existing girls-princess-dress preset assertion remains unrelated (`contentFallback` expected `mannequin`, actual `none`).
- Development desktop app: started from `full-source-app`; backend health on port 4000 returned `ok`.
- Live Google generation was not triggered automatically; user testing is required to consume credits intentionally.
