# Veo3 Gen Studio

The desktop sidebar exposes Veo3 Gen Studio beside the existing Gen Veo3 page.
Its project home was recovered from the existing VeoWorkflow renderer bundle,
compared with the installed Veo3Studio 1.9.8 renderer, and lives in
`apps/renderer/src/pages/StudioGenHome.js`. The existing generation
detail source in `GenNormalDetailPage.js` supplies image and video prompting,
reference uploads, job polling, retries, downloads, and upscale controls. Both
pages use the Veo3Studio 1.9.8 generation core already merged into
`apps/server/src/services/veo3`.

In Studio mode the detail page hides VeoWorkflow-only Manga, Story/CapCut and
prompt-rewrite panels. Its project home uses the same labels and style classes
as the installed 1.9.8 Gen home. Studio mode also uses the original 25–60
second delay choices and a 30 second default for new projects. The existing
Gen page keeps its image choices and uses the Studio range for video.

Studio projects use `source=studio`; the Story-enabled Gen page keeps
`source=normal`. Listing, creating, deleting all projects, and orphan cleanup
are scoped to that source. Profiles and the generation engine are shared, so
there is one account/session state rather than duplicated credentials.

Studio projects default to serial upscale. The additive database column uses
`false` for existing projects to preserve their current throughput. Database
initialization adds the column to older databases before Prisma reads them.

The CDP CAPTCHA provider now uses a dedicated, user-controlled Chrome window,
as in Veo3Studio 1.9.8. It serializes mint requests, bounds the pending queue,
and resets that window after repeated mint timeouts or twelve successful mints.
The user may need to sign in to Google Flow in this window. The legacy server
profile context remains available until the Electron shell is rebuilt, so an
older shell does not lose its current CAPTCHA path during source development.
When VeoWorkflow has a global SOCKS5 proxy, the CAPTCHA Chrome launches with
that rule and restarts when the rule changes. Veo3Studio's optional CloakBrowser
engine and authenticated proxy gateway are not part of this source update.

Both Gen pages share Veo3Studio's four-video burst default and the 25–60 second
pause range for video batches. Browser recovery for a video 403 streak starts
after three consecutive rejections; the first two use delayed retries. The
existing in-flight submission guard, local workflow behavior, and actionable
verification errors are retained. Video rows that Flow did not accept are
requeued, including a short response with no explicit failed-items list; rows
with accepted operations are never resubmitted. No package, release, or Desktop
shortcut is changed by this source update.
