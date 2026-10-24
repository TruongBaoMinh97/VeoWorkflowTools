import { logger } from './logger.js';
import { createHash } from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';
let cachedDatabase = null;
let nativeLoadError = null;
function requireDatabase() {
    if (nativeLoadError)
        throw nativeLoadError;
    if (!cachedDatabase) {
        try {
            const req = createRequire(import.meta.url);
            cachedDatabase = req('better-sqlite3');
        }
        catch (err) {
            nativeLoadError = err instanceof Error ? err : new Error(String(err));
            throw nativeLoadError;
        }
    }
    return cachedDatabase;
}
/**
 * Extract all CREATE TABLE statements from raw SQLite file.
 * SQLite stores schema SQL as plain text in sqlite_master → readable without
 * native module. Returns sorted, normalized schema string for hashing.
 */
function extractSchemaFromRawSqlite(dbPath) {
    try {
        const buffer = fs.readFileSync(dbPath);
        const content = buffer.toString('utf-8');
        const createStatements = [];
        const regex = /CREATE\s+TABLE\s+["'`]?(\w+)["'`]?\s*\([^)]*(?:\([^)]*\)[^)]*)*\)/gi;
        let match;
        while ((match = regex.exec(content)) !== null) {
            const tableName = match[1];
            if (!tableName || tableName.startsWith('_prisma') || tableName.startsWith('sqlite_'))
                continue;
            createStatements.push(match[0].replace(/\s+/g, ' ').trim());
        }
        if (createStatements.length === 0)
            return null;
        createStatements.sort();
        return createStatements.join('\n');
    }
    catch {
        return null;
    }
}
function hashSchema(schema) {
    return createHash('sha256').update(schema).digest('hex').substring(0, 16);
}
/** Sidecar file recording the template schema-hash this user DB was reconciled to. */
function schemaMarkerPath(userDbPath) {
    return `${userDbPath}.schemahash`;
}
/**
 * Record that the user DB has been reconciled to the current template schema.
 * The raw-text CREATE TABLE hash is order/format-sensitive: after an additive
 * reconcile (ALTER TABLE ADD COLUMN) the user schema is equivalent to the
 * template but its serialized text — and thus its hash — never equals the
 * template's again. Without this marker the app would back up + reconcile on
 * EVERY launch forever. Call after a successful reconcile.
 */
export function markSchemaReconciled(userDbPath, templateDbPath) {
    try {
        const templateSchema = extractSchemaFromRawSqlite(templateDbPath);
        if (!templateSchema)
            return;
        fs.writeFileSync(schemaMarkerPath(userDbPath), hashSchema(templateSchema));
    }
    catch {
        /* best-effort — never block startup on marker write */
    }
}
/**
 * Read SQLite schema_cookie from file header (offset 40-43, big-endian 32-bit).
 */
function readSqliteSchemaCookie(dbPath) {
    try {
        const buf = Buffer.alloc(4);
        const fd = fs.openSync(dbPath, 'r');
        const bytesRead = fs.readSync(fd, buf, 0, 4, 40);
        fs.closeSync(fd);
        if (bytesRead < 4)
            return null;
        return buf.readUInt32BE(0);
    }
    catch {
        return null;
    }
}
/**
 * Compare schema between template.db and user.db.
 *  - Method 1 (primary): hash all CREATE TABLE SQL statements
 *  - Method 2 (fallback): SQLite schema_cookie at byte 40
 */
export function checkSchemaVersion(userDbPath, templateDbPath) {
    const templateSchema = extractSchemaFromRawSqlite(templateDbPath);
    const userSchema = extractSchemaFromRawSqlite(userDbPath);
    if (templateSchema && userSchema) {
        const templateHash = hashSchema(templateSchema);
        const userHash = hashSchema(userSchema);
        logger.info('🔍 Schema hash check:', { userHash, templateHash });
        if (templateHash !== userHash) {
            // The raw-text CREATE TABLE hash is order/format-sensitive: after an
            // additive reconcile (ALTER TABLE ADD COLUMN) the user schema is
            // equivalent to the template but its serialized text — and thus this hash
            // — never equals it again. If we already reconciled this DB to the current
            // template, a marker records it → skip the pointless re-backup+reconcile.
            try {
                const marker = fs.readFileSync(schemaMarkerPath(userDbPath), 'utf8').trim();
                if (marker === templateHash) {
                    return {
                        needsUpdate: false,
                        reason: `Schema reconciled to template ${templateHash} (marker)`,
                        userCookie: null,
                        templateCookie: null,
                    };
                }
            }
            catch {
                /* no marker yet → fall through to reconcile */
            }
            return {
                needsUpdate: true,
                reason: `Schema hash mismatch: user=${userHash}, template=${templateHash}`,
                userCookie: null,
                templateCookie: null,
            };
        }
        return { needsUpdate: false, reason: `Schema hash match: ${userHash}`, userCookie: null, templateCookie: null };
    }
    const templateCookie = readSqliteSchemaCookie(templateDbPath);
    const userCookie = readSqliteSchemaCookie(userDbPath);
    logger.info('🔍 Schema cookie fallback:', { userCookie, templateCookie });
    if (templateCookie === null) {
        return { needsUpdate: true, reason: 'Không đọc được template — force update', userCookie, templateCookie };
    }
    if (userCookie === null) {
        return { needsUpdate: true, reason: 'Không đọc được user DB — cần reset', userCookie, templateCookie };
    }
    if (userCookie !== templateCookie) {
        return {
            needsUpdate: true,
            reason: `Schema cookie mismatch: user=${userCookie}, template=${templateCookie}`,
            userCookie,
            templateCookie,
        };
    }
    return { needsUpdate: false, reason: 'Schema cookie match', userCookie, templateCookie };
}
/**
 * Force reset: backup user DB and replace with a fresh copy of template.
 */
export function forceResetDatabase(userDbPath, templateDbPath) {
    try {
        if (fs.existsSync(userDbPath)) {
            const backupPath = `${userDbPath}.backup.${Date.now()}`;
            fs.copyFileSync(userDbPath, backupPath);
            logger.info('Old database backed up to:', backupPath);
            fs.unlinkSync(userDbPath);
        }
        if (fs.existsSync(templateDbPath)) {
            fs.copyFileSync(templateDbPath, userDbPath);
            logger.info('Fresh database created from template');
            return true;
        }
        logger.error('Template database not found:', templateDbPath);
        return false;
    }
    catch (error) {
        logger.error('Failed to reset database:', error.message);
        return false;
    }
}
/**
 * Có dữ liệu người dùng thực sự không? Dùng để CẤM mọi thao tác wipe/replace
 * lên DB đang chứa profile/project. Bảng không tồn tại → coi như 0 (không chặn).
 *
 * Trả về `true` / `false` chỉ khi xác minh được. Khi không mở được DB (ví dụ
 * better-sqlite3 native module fail load do mismatch arch/ABI), hàm **throw**
 * để caller bắt buộc xử lý case "không biết". Trước đây silent-return false
 * dẫn đến code fallback "install fresh template" đè mất DB user — fix gốc
 * của lỗi mất dữ liệu khi reinstall trên Windows.
 */
export function databaseHasUserData(userDbPath) {
    const KEY_TABLES = ['Profile', 'GenNormalProject', 'GenNormalJob'];
    let db = null;
    try {
        db = new (requireDatabase())(userDbPath, { readonly: true, fileMustExist: true });
        const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
        for (const t of KEY_TABLES) {
            if (!existing.has(t))
                continue;
            const row = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get();
            if (row && row.c > 0)
                return true;
        }
        return false;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('[DB] databaseHasUserData check failed:', message);
        throw new Error(`databaseHasUserData failed: ${message}`);
    }
    finally {
        try {
            db?.close();
        }
        catch { /* ignore */ }
    }
}
/**
 * Heuristic file-size check khi không thể đọc DB. User DB lớn hơn template
 * `MIN_OCCUPIED_RATIO` lần → gần như chắc chắn đã chứa profile/job data
 * (template chỉ có schema rỗng). Dùng làm backup signal khi
 * databaseHasUserData throw.
 */
const MIN_OCCUPIED_RATIO = 1.1;
export function dbFileLooksOccupied(userDbPath, templateDbPath) {
    try {
        const userSize = fs.statSync(userDbPath).size;
        const tplSize = fs.statSync(templateDbPath).size;
        if (!Number.isFinite(userSize) || userSize <= 0)
            return false;
        if (!Number.isFinite(tplSize) || tplSize <= 0)
            return userSize > 50 * 1024;
        return userSize > tplSize * MIN_OCCUPIED_RATIO;
    }
    catch {
        return false;
    }
}
/**
 * Reconcile schema theo hướng CỘNG DỒN (additive) — KHÔNG phá dữ liệu.
 * Thêm bảng / cột / index còn thiếu từ template vào DB user; KHÔNG bao giờ drop.
 * Toàn bộ chạy trong 1 transaction: hoặc áp dụng trọn vẹn, hoặc giữ nguyên DB.
 *
 * Trả `{ ok }`: ok=false nghĩa là không reconcile được (DB hỏng) → caller fallback.
 */
export function reconcileSchemaAdditive(userDbPath, templateDbPath) {
    const applied = [];
    let usr = null;
    let tpl = null;
    try {
        const DatabaseCtor = requireDatabase();
        tpl = new DatabaseCtor(templateDbPath, { readonly: true, fileMustExist: true });
        usr = new DatabaseCtor(userDbPath, { fileMustExist: true });
        const tplTables = tpl.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        const ddl = [];
        // 1) Bảng + cột thiếu
        for (const t of tplTables) {
            const usrTbl = usr.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t.name);
            if (!usrTbl) {
                if (t.sql) {
                    ddl.push(t.sql);
                    applied.push(`+table ${t.name}`);
                }
                continue;
            }
            const tplCols = tpl.prepare(`PRAGMA table_info("${t.name}")`).all();
            const usrCols = new Set(usr.prepare(`PRAGMA table_info("${t.name}")`).all().map((c) => c.name));
            for (const c of tplCols) {
                if (usrCols.has(c.name))
                    continue;
                // SQLite không cho ADD COLUMN với PRIMARY KEY/UNIQUE — bỏ qua an toàn.
                if (c.pk) {
                    logger.warn(`[DB reconcile] skip PK column ${t.name}.${c.name}`);
                    continue;
                }
                let def = '';
                if (c.dflt_value != null) {
                    def = ` DEFAULT ${c.dflt_value}`;
                }
                else if (c.notnull) {
                    // NOT NULL bắt buộc có default khi ADD COLUMN — chọn default trung tính theo type.
                    const ty = (c.type || '').toUpperCase();
                    const fallback = /INT|REAL|NUM|DEC|DOUB|FLOA/.test(ty) ? '0' : "''";
                    def = ` DEFAULT ${fallback}`;
                }
                ddl.push(`ALTER TABLE "${t.name}" ADD COLUMN "${c.name}" ${c.type || 'TEXT'}${def}`);
                applied.push(`+column ${t.name}.${c.name}`);
            }
        }
        // 2) Index thiếu
        const tplIdx = tpl.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all();
        for (const i of tplIdx) {
            const exists = usr.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?").get(i.name);
            if (exists || !i.sql)
                continue;
            ddl.push(i.sql.replace(/^CREATE\s+INDEX/i, 'CREATE INDEX IF NOT EXISTS'));
            applied.push(`+index ${i.name}`);
        }
        if (ddl.length === 0) {
            logger.info('[DB reconcile] Schema khác hash nhưng không có bảng/cột/index thiếu — bỏ qua.');
            return { ok: true, applied };
        }
        const runAll = usr.transaction((stmts) => {
            for (const s of stmts)
                usr.exec(s);
        });
        runAll(ddl);
        logger.info(`[DB reconcile] ✅ Áp dụng ${applied.length} thay đổi schema (giữ nguyên dữ liệu):`, { applied });
        return { ok: true, applied };
    }
    catch (error) {
        logger.error('[DB reconcile] ❌ Reconcile thất bại (DB có thể hỏng):', error?.message);
        return { ok: false, applied, error: error?.message };
    }
    finally {
        try {
            usr?.close();
        }
        catch { /* ignore */ }
        try {
            tpl?.close();
        }
        catch { /* ignore */ }
    }
}
