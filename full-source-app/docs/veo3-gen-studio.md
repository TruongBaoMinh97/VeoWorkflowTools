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
second delay choices and a 30 second default for new projects; the existing
Gen page keeps its current choices.

Studio projects use `source=studio`; the Story-enabled Gen page keeps
`source=normal`. Listing, creating, deleting all projects, and orphan cleanup
are scoped to that source. Profiles and the generation engine are shared, so
there is one account/session state rather than duplicated credentials.

Studio projects default to serial upscale. The additive database column uses
`false` for existing projects to preserve their current throughput. Database
initialization adds the column to older databases before Prisma reads them.

CAPTCHA minting stays bound to the selected profile's signed-in Chrome session.
This is a VeoWorkflow safety adaptation of the Studio module, and a generation
may open that Chrome window when it is not already connected. The upstream
dedicated CAPTCHA browser and optional CloakBrowser mode are not installed by
this module. No release package or Desktop shortcut is changed by this source
update.
