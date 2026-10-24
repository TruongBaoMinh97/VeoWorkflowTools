import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/**
 * Register update routes for electron-updater
 * These routes serve update information and files for auto-updater
 */
export async function registerUpdateRoutes(app) {
    // Get current app version from package.json
    const getAppVersion = () => {
        try {
            // Try to read from root package.json (3 levels up from this file)
            const packageJsonPath = join(__dirname, '..', '..', '..', '..', '..', 'package.json');
            const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
            return packageJson.version || '1.0.0';
        }
        catch {
            try {
                // Fallback to current directory
                const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
                return packageJson.version || '1.0.0';
            }
            catch {
                return '1.0.0';
            }
        }
    };
    /**
     * GET /api/update/check
     * Check for updates - returns latest version info
     * This endpoint is used by electron-updater to check for new versions
     */
    app.get('/api/update/check', async (request, reply) => {
        const currentVersion = request.query;
        const appVersion = getAppVersion();
        // In a real implementation, you would:
        // 1. Compare currentVersion with latest version from database/CDN
        // 2. Return update info if newer version exists
        // 3. For now, we return current version info
        reply.send({
            version: appVersion,
            releaseDate: new Date().toISOString(),
            releaseNotes: 'Latest version',
            // electron-updater expects these fields for generic provider
            url: `${process.env.UPDATE_SERVER_URL || 'https://updates.veo3studio.com'}/latest`,
        });
    });
    /**
     * GET /api/update/latest
     * Get latest version information
     * Used by electron-updater to get update metadata
     */
    app.get('/api/update/latest', async (request, reply) => {
        const platform = request.query?.platform || process.platform;
        const appVersion = getAppVersion();
        // In production, you would:
        // 1. Query database or CDN for latest version
        // 2. Return platform-specific update info
        // 3. Include download URLs for .dmg (macOS) or .exe (Windows)
        reply.send({
            version: appVersion,
            releaseDate: new Date().toISOString(),
            releaseNotes: 'Latest version available',
            platform,
            // electron-updater will construct download URL from this
            // Format: {UPDATE_SERVER_URL}/latest-mac.yml or latest.yml
        });
    });
    /**
     * GET /api/update/version
     * Simple endpoint to get current app version
     */
    app.get('/api/update/version', async (request, reply) => {
        reply.send({
            version: getAppVersion(),
            timestamp: new Date().toISOString(),
        });
    });
}
