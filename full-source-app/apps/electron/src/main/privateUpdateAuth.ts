type UpdateFeed = {
  provider: "github";
  owner: string;
  repo: string;
  private: boolean;
  token?: string;
};

type UpdaterFeedClient = {
  setFeedURL(feed: UpdateFeed): void;
};

export const feed: UpdateFeed = {
  provider: "github",
  owner: "TruongBaoMinh",
  repo: "VeoWorkflowTools",
  private: false,
};

/**
 * Keep the historical export name because the existing Electron main process
 * imports it. Public releases require no GitHub credentials on client machines.
 * An optional token is accepted for development or if the repository becomes
 * private again, but it is kept in memory and never written to disk.
 */
export async function configurePrivateUpdate(autoUpdater: UpdaterFeedClient): Promise<void> {
  const token =
    process.env.VEO_WORKFLOW_GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN;

  autoUpdater.setFeedURL(token ? { ...feed, token: token.trim() } : feed);
}
