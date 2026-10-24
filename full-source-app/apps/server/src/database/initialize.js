/**
 * Database Initialization
 * Handles database setup, migrations, and template management
 */
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../lib/logger.js';
import { checkSchemaVersion, reconcileSchemaAdditive, databaseHasUserData, dbFileLooksOccupied, markSchemaReconciled } from '../lib/databaseSchemaChecker.js';
import { markPrismaInitialized } from '../lib/prisma.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Server root is two levels up from database/
const SERVER_ROOT = path.join(__dirname, '..', '..');
/**
 * Parse DATABASE_URL to extract the file path.
 * Supports Prisma SQLite URL formats:
 * - file:C:/path (Windows preferred)
 * - file:///C:/path (legacy triple-slash)
 * - file:/path (Unix)
 * - file:./relative
 */
function parseDatabasePath(dbUrl) {
    if (dbUrl.startsWith('file:///')) {
        return decodeURIComponent(dbUrl.substring(8));
    }
    if (dbUrl.startsWith('file://')) {
        return decodeURIComponent(dbUrl.substring(7));
    }
    if (dbUrl.startsWith('file:')) {
        return decodeURIComponent(dbUrl.substring(5));
    }
    return dbUrl;
}
function resolveDatabasePath(dbPathRaw) {
    const normalized = path.normalize(dbPathRaw);
    if (path.isAbsolute(normalized)) {
        return path.resolve(normalized);
    }
    return path.resolve(SERVER_ROOT, normalized);
}
function checkDatabaseExists(dbPath) {
    try {
        if (fs.existsSync(dbPath))
            return true;
        fs.accessSync(dbPath, fs.constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
function isPackagedApp() {
    return !!(process.env.ELECTRON_RUN_AS_NODE ||
        process.env.npm_config_user_config?.includes('.electron') ||
        process.env.NODE_ENV === 'production');
}
/**
 * Initialize database for packaged Electron app.
 * Copies template.db to user location if needed, checks schema version.
 */
function initializePackagedDatabase(absoluteDbPath, dbExists) {
    const prismaPath = path.join(SERVER_ROOT, 'prisma');
    const templateDbPath = path.join(prismaPath, 'template.db');
    logger.info('Running in packaged Electron app');
    if (!fs.existsSync(templateDbPath)) {
        logger.error('Database template not found!', {
            templatePath: templateDbPath,
            prismaPath,
            prismaContents: fs.existsSync(prismaPath) ? fs.readdirSync(prismaPath) : [],
        });
        throw new Error(`Database template not found at ${templateDbPath}. App cannot start without it.`);
    }
    logger.info('Found database template');
    // Double-verify existence (existsSync can lie on network drives)
    let actuallyExists = dbExists;
    if (!actuallyExists) {
        try {
            const stats = fs.statSync(absoluteDbPath);
            if (stats && stats.size > 0) {
                actuallyExists = true;
                logger.warn('Database reported missing by existsSync but found by statSync!', { size: stats.size });
            }
        }
        catch {
            // Truly not there
        }
    }
    const needsCopy = !actuallyExists ||
        (fs.existsSync(absoluteDbPath) && fs.statSync(absoluteDbPath).size === 0);
    if (needsCopy) {
        copyTemplateDatabase(templateDbPath, absoluteDbPath);
    }
    else {
        checkAndUpdateSchema(absoluteDbPath, templateDbPath);
    }
    markPrismaInitialized();
    logger.info('Database initialization complete - Prisma ready');
}
function copyTemplateDatabase(templatePath, targetPath) {
    const dbDir = path.dirname(targetPath);
    logger.info('Copying database template to user location...', {
        from: templatePath,
        to: targetPath,
        templateSize: `${(fs.statSync(templatePath).size / 1024).toFixed(2)} KB`,
    });
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        logger.info('Created database directory', { dir: dbDir });
    }
    fs.copyFileSync(templatePath, targetPath);
    const copiedSize = fs.statSync(targetPath).size;
    const templateSize = fs.statSync(templatePath).size;
    if (copiedSize === templateSize && copiedSize > 0) {
        logger.info('Database template copied successfully', {
            size: `${(copiedSize / 1024).toFixed(2)} KB`,
        });
    }
    else {
        throw new Error(`Template copy verification failed: copied ${copiedSize} bytes, expected ${templateSize} bytes`);
    }
}
function checkAndUpdateSchema(dbPath, templateDbPath) {
    const dbSize = fs.statSync(dbPath).size;
    logger.info('User database already exists', { size: `${(dbSize / 1024).toFixed(2)} KB` });
    logger.info('Checking database schema version via schema_cookie...');
    const versionCheck = checkSchemaVersion(dbPath, templateDbPath);
    logger.info(`   ${versionCheck.reason}`, {
        userCookie: versionCheck.userCookie,
        templateCookie: versionCheck.templateCookie,
    });
    if (!versionCheck.needsUpdate) {
        logger.info('Database schema is up-to-date — no replacement needed');
        return;
    }
    // Schema lệch → KHÔNG ghi đè DB user (tránh mất profile/project). Thay vào đó
    // reconcile cộng dồn: thêm bảng/cột/index thiếu, giữ nguyên dữ liệu.
    logger.warn('Database schema outdated — reconciling additively (data preserved)...');
    // Backup phòng hờ trước khi đụng vào DB.
    const backupPath = `${dbPath}.backup.${Date.now()}`;
    try {
        fs.copyFileSync(dbPath, backupPath);
        logger.info(`Old database backed up to: ${path.basename(backupPath)}`);
    }
    catch (backupError) {
        logger.warn('Failed to backup old database:', backupError.message);
    }
    const result = reconcileSchemaAdditive(dbPath, templateDbPath);
    if (result.ok) {
        // Persist a convergence marker so the next launch does NOT back up +
        // reconcile again. The raw-text schema hash never re-matches the template
        // after ALTER TABLE ADD COLUMN, which otherwise loops forever.
        markSchemaReconciled(dbPath, templateDbPath);
        logger.info('Database schema reconciled — user data preserved', {
            changes: result.applied.length,
        });
        return;
    }
    // Reconcile thất bại. CHỈ replace bằng template khi CHẮC CHẮN DB rỗng.
    // Trước đây databaseHasUserData silent-return false khi không đọc được DB
    // (vd better-sqlite3 fail load do mismatch Win32 arch sau khi user reinstall
    // qua version khác) → caller nghĩ rỗng → đè template lên 588KB user data.
    // Giờ databaseHasUserData throw → caller treat-as-occupied + dùng thêm
    // file-size heuristic làm backup signal.
    let hasUserData;
    let hasUserDataKnown;
    try {
        hasUserData = databaseHasUserData(dbPath);
        hasUserDataKnown = true;
    }
    catch (err) {
        hasUserData = false;
        hasUserDataKnown = false;
        logger.warn('[DB] Could not verify user data — falling back to file-size heuristic', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    const looksOccupied = dbFileLooksOccupied(dbPath, templateDbPath);
    if (hasUserData || (!hasUserDataKnown && looksOccupied)) {
        const reason = !hasUserDataKnown
            ? 'user-data check failed but DB file is larger than template (likely has data)'
            : 'DB contains user data';
        // Lỗi native-load (bundle better-sqlite3 sai ABI/arch — đã xảy ra trên
        // macOS: prebuild Node 127 chạy dưới Electron 130) KHÔNG được giết server:
        // Prisma dùng engine riêng, không đụng better-sqlite3, nên app vẫn chạy
        // bình thường — chỉ reconcile schema bị bỏ qua lượt này. KHÔNG ghi
        // schema-marker để lần boot sau (bản update có binary đúng) reconcile lại.
        const errorText = String(result.error ?? '');
        const isNativeLoadFailure = errorText.includes('NODE_MODULE_VERSION') ||
            errorText.includes('compiled against a different') ||
            errorText.includes('ERR_DLOPEN');
        if (isNativeLoadFailure) {
            logger.warn('[DB] Bỏ qua reconcile schema: better-sqlite3 sai ABI (bundle lỗi). ' +
                'Dữ liệu an toàn, Prisma hoạt động bình thường. ' +
                'Cập nhật app lên bản mới nhất để khôi phục reconcile.', { nativeError: errorText, backup: path.basename(backupPath) });
            return;
        }
        logger.error(`Schema reconcile failed; ${reason} — refusing to overwrite.`, {
            error: result.error,
            backup: path.basename(backupPath),
        });
        throw new Error(`Database schema reconcile failed (${reason}). Refusing to wipe. ` +
            `Backup: ${path.basename(backupPath)}. ` +
            `Original error: ${result.error}. ` +
            `If you reinstalled the app, the native sqlite module may have a wrong architecture — reinstall the latest version for your OS.`);
    }
    logger.warn('Reconcile failed and DB has no user data — installing fresh template (last resort).');
    fs.copyFileSync(templateDbPath, dbPath);
    const newDbSize = fs.statSync(dbPath).size;
    logger.info('Fresh database installed from latest template', {
        size: `${(newDbSize / 1024).toFixed(2)} KB`,
    });
}
/**
 * Initialize database for development mode using Prisma CLI.
 */
function initializeDevDatabase(absoluteDbPath, dbDir, dbUrl, dbExists) {
    logger.info('Development mode detected');
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        logger.info('Created database directory for dev mode', { dir: dbDir });
    }
    if (isMigrationUpToDate(dbUrl, dbExists)) {
        markPrismaInitialized();
        logger.info('Database initialization complete (dev mode) - Prisma ready');
        return;
    }
    runMigrations(absoluteDbPath, dbUrl, dbExists);
    markPrismaInitialized();
    logger.info('Database initialization complete (dev mode) - Prisma ready');
}
function isMigrationUpToDate(dbUrl, dbExists) {
    if (!dbExists)
        return false;
    try {
        const statusOutput = execSync('npx prisma migrate status', {
            cwd: SERVER_ROOT,
            stdio: 'pipe',
            env: { ...process.env, DATABASE_URL: dbUrl },
        }).toString();
        if (statusOutput.includes('Database schema is up to date') ||
            statusOutput.includes('All migrations have been applied')) {
            logger.info('Database migrations are already up-to-date, skipping migration');
            return true;
        }
        logger.info('Pending migrations detected, will run migrate deploy');
        return false;
    }
    catch (statusError) {
        const output = statusError.stdout?.toString() || statusError.stderr?.toString() || '';
        if (output.includes('Database schema is up to date') ||
            output.includes('All migrations have been applied')) {
            return true;
        }
        logger.warn('Could not determine migration status, will attempt migration');
        return false;
    }
}
function runMigrations(absoluteDbPath, dbUrl, dbExists) {
    const migrationsPath = path.join(SERVER_ROOT, 'prisma', 'migrations');
    const migrationsExist = fs.existsSync(migrationsPath);
    if (!migrationsExist) {
        logger.warn('Migrations directory not found, will use schema.prisma directly');
    }
    const hasData = dbExists && fs.existsSync(absoluteDbPath) && fs.statSync(absoluteDbPath).size > 1024;
    try {
        execSync('npx prisma migrate deploy', {
            cwd: SERVER_ROOT,
            stdio: 'pipe',
            env: { ...process.env, DATABASE_URL: dbUrl },
            encoding: 'utf-8',
        });
        logger.info('Database migrations completed - database is now up-to-date');
        if (fs.existsSync(absoluteDbPath)) {
            const finalDbSize = fs.statSync(absoluteDbPath).size;
            logger.info(`Database file verified (${(finalDbSize / 1024).toFixed(2)} KB)`);
        }
    }
    catch (error) {
        const errorMessage = extractErrorMessage(error);
        logger.error('Database migration failed', { error: errorMessage, hasData });
        handleMigrationError(errorMessage, hasData, dbUrl, migrationsPath);
    }
}
function extractErrorMessage(error) {
    if (error.message) {
        return typeof error.message === 'string' ? error.message : String(error.message);
    }
    if (error.stderr) {
        return Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf-8') : String(error.stderr);
    }
    if (error.stdout) {
        return Buffer.isBuffer(error.stdout) ? error.stdout.toString('utf-8') : String(error.stdout);
    }
    return String(error);
}
function handleMigrationError(errorMessage, hasData, dbUrl, migrationsPath) {
    const isP3005 = errorMessage.includes('P3005');
    if (isP3005) {
        logger.warn('P3005: Migration history not initialized. Baselining existing migrations...');
        try {
            const migPath = migrationsPath || path.join(SERVER_ROOT, 'prisma', 'migrations');
            const migDirs = fs.readdirSync(migPath)
                .filter(item => {
                const itemPath = path.join(migPath, item);
                return fs.statSync(itemPath).isDirectory() && /^\d{14}_/.test(item);
            })
                .sort();
            for (const migName of migDirs) {
                try {
                    execSync(`npx prisma migrate resolve --applied "${migName}"`, {
                        cwd: SERVER_ROOT,
                        stdio: 'pipe',
                        env: { ...process.env, DATABASE_URL: dbUrl },
                    });
                    logger.info(`Marked migration as applied: ${migName}`);
                }
                catch (resolveError) {
                    logger.warn(`Could not mark migration ${migName} as applied`, {
                        error: resolveError.message,
                    });
                }
            }
            logger.info('Baseline complete. Running migrate deploy again...');
            execSync('npx prisma migrate deploy', {
                cwd: SERVER_ROOT,
                stdio: 'pipe',
                env: { ...process.env, DATABASE_URL: dbUrl },
            });
            logger.info('Database migrations completed after baseline');
        }
        catch (baselineError) {
            logger.error('Baseline failed, falling back to db push', { error: baselineError.message });
            fallbackDbPush(hasData, dbUrl);
        }
    }
    else {
        fallbackDbPush(hasData, dbUrl);
    }
}
function fallbackDbPush(hasData, dbUrl) {
    if (hasData) {
        logger.error('Cannot run db push - database has data and migration failed');
        return;
    }
    try {
        execSync('npx prisma db push', {
            cwd: SERVER_ROOT,
            stdio: 'pipe',
            env: { ...process.env, DATABASE_URL: dbUrl },
        });
        logger.info('Database schema pushed successfully via db push (no migration history)');
    }
    catch (pushError) {
        logger.error(`Failed to push database schema: ${extractErrorMessage(pushError)}`);
    }
}
/**
 * Main database initialization entry point
 */
export async function initializeDatabase() {
    try {
        const dbUrl = process.env.DATABASE_URL || 'file:./prisma/dev.db';
        const dbPathRaw = parseDatabasePath(dbUrl);
        const absoluteDbPath = resolveDatabasePath(dbPathRaw);
        const dbDir = path.dirname(absoluteDbPath);
        const dbExists = checkDatabaseExists(absoluteDbPath);
        const prismaPath = path.join(SERVER_ROOT, 'prisma');
        if (!fs.existsSync(prismaPath)) {
            logger.warn('Prisma directory not found, skipping migrations', { path: prismaPath });
            return;
        }
        logger.info('Starting database initialization', {
            isPackaged: isPackagedApp(),
            platform: process.platform,
            dbExists,
        });
        if (isPackagedApp()) {
            initializePackagedDatabase(absoluteDbPath, dbExists);
        }
        else {
            initializeDevDatabase(absoluteDbPath, dbDir, dbUrl, dbExists);
        }
    }
    catch (error) {
        logger.error('Database initialization error', { error: error.message });
    }
}
