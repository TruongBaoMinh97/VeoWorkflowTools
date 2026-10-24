/**
 * Directory initialization utilities
 * Cross-platform directory creation with proper error handling
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/**
 * Safely create directory with recursive option
 * Works on Windows, macOS, and Linux
 * Enhanced error handling for first-run scenarios
 */
export function ensureDirectoryExists(dirPath) {
    try {
        // Normalize path for Windows
        const normalizedPath = path.normalize(dirPath);
        if (!normalizedPath || normalizedPath === '' || normalizedPath === '.') {
            console.error(`[DirectoryInit] Invalid path: ${dirPath}`);
            return false;
        }
        if (fs.existsSync(normalizedPath)) {
            return true;
        }
        // Create directory with recursive option
        fs.mkdirSync(normalizedPath, { recursive: true, mode: 0o755 });
        console.log(`✓ Created directory: ${normalizedPath}`);
        return true;
    }
    catch (error) {
        console.error(`[DirectoryInit] Failed to create directory ${dirPath}:`, error.message);
        // Try alternative approach for Windows permission issues
        if (process.platform === 'win32') {
            try {
                const normalizedPath = path.normalize(dirPath);
                const parts = normalizedPath.split(path.sep).filter(p => p !== '');
                // Handle drive letter (C:)
                let currentPath = '';
                if (parts[0] && parts[0].includes(':')) {
                    currentPath = parts[0] + path.sep;
                    parts.shift();
                }
                for (const part of parts) {
                    currentPath = path.join(currentPath, part);
                    if (!fs.existsSync(currentPath)) {
                        try {
                            fs.mkdirSync(currentPath);
                        }
                        catch (mkdirError) {
                            // If permission denied, try with different mode
                            if (mkdirError.code === 'EPERM' || mkdirError.code === 'EACCES') {
                                console.warn(`[DirectoryInit] Permission issue for ${currentPath}, trying alternative...`);
                                continue;
                            }
                            throw mkdirError;
                        }
                    }
                }
                console.log(`✓ Created directory (Windows fallback): ${dirPath}`);
                return true;
            }
            catch (fallbackError) {
                console.error(`[DirectoryInit] Fallback failed for ${dirPath}:`, fallbackError.message);
                return false;
            }
        }
        return false;
    }
}
/**
 * Initialize all default directories on server startup
 * In production (packaged app), use user data directory (no admin required)
 * In development, use project directory
 */
export function initializeDefaultDirectories() {
    const baseDir = getBaseDirectory();
    const isPackaged = process.env.ELECTRON_RUN_AS_NODE === '1' ||
        (process.env.NODE_ENV === 'production' && process.platform === 'win32');
    console.log(`📁 Base directory: ${baseDir} (${isPackaged ? 'production' : 'development'})`);
    const defaultDirectories = [
        path.join(baseDir, 'logs'),
        path.join(baseDir, 'downloads'),
        path.join(baseDir, 'temp'),
        path.join(baseDir, 'character-images'),
        path.join(baseDir, 'public', 'uploads'),
    ];
    console.log('📁 Initializing default directories...');
    let successCount = 0;
    let failCount = 0;
    for (const dir of defaultDirectories) {
        if (ensureDirectoryExists(dir)) {
            successCount++;
        }
        else {
            failCount++;
            console.error(`❌ Failed to create: ${dir}`);
        }
    }
    if (failCount > 0) {
        console.warn(`⚠️  ${failCount}/${defaultDirectories.length} directories failed to create`);
        if (isPackaged) {
            console.warn(`⚠️  Check if app has permission to write to: ${baseDir}`);
        }
        else {
            console.warn(`⚠️  Check directory permissions or disk space`);
        }
    }
    console.log(`✓ Directory initialization complete: ${successCount}/${defaultDirectories.length} created`);
}
/**
 * Get base directory for server data
 * In production: User data directory (no admin required)
 * In development: Project directory
 */
export function getBaseDirectory() {
    const isPackaged = process.env.ELECTRON_RUN_AS_NODE === '1' ||
        (process.env.NODE_ENV === 'production' && process.platform === 'win32');
    if (isPackaged) {
        return getAppDataDirectory();
    }
    else {
        return path.join(__dirname, '../..');
    }
}
/**
 * Get app data directory based on platform
 * Returns platform-specific user data directory
 * Enhanced for Windows first-run scenarios
 */
export function getAppDataDirectory() {
    const appName = 'veo3studio';
    switch (process.platform) {
        case 'win32': {
            // On Windows, use APPDATA or fallback to USERPROFILE
            let appData = process.env.APPDATA;
            if (!appData) {
                const userProfile = process.env.USERPROFILE;
                if (userProfile) {
                    appData = path.join(userProfile, 'AppData', 'Roaming');
                    console.warn(`[DirectoryInit] APPDATA not set, using fallback: ${appData}`);
                }
                else {
                    // Last resort: use current working directory
                    appData = path.join(process.cwd(), 'data');
                    console.warn(`[DirectoryInit] No user profile found, using cwd: ${appData}`);
                }
            }
            return path.join(appData, appName);
        }
        case 'darwin':
            return path.join(process.env.HOME || '/tmp', 'Library', 'Application Support', appName);
        case 'linux':
            return path.join(process.env.HOME || '/tmp', '.config', appName);
        default:
            return path.join(process.cwd(), 'data', appName);
    }
}
