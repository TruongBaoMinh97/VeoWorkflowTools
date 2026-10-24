import { z } from 'zod';
import { profileSchema, profileService } from './profile.service.js';
import { logger } from '../../lib/logger.js';
import { refreshProfileAccountInfo, refreshManyProfileAccountInfo } from './accountInfo.service.js';
import { hasGoogleSignIn } from './sessionCookie.js';
import { checkFlowSignIn } from '../../lib/flowBoq.js';

function signedOutFlowError(profileId) {
    logger.warn(`[Profile] Google sign-in cookies missing for ${profileId.substring(0, 8)} — re-login required`);
    return {
        code: 'FLOW_SIGNED_OUT',
        message: 'Profile chưa đăng nhập tài khoản Google cho Flow AI.',
        action: 'Vui lòng đăng nhập lại và GIỮ cửa sổ Chrome mở cho đến khi trang ' +
            'flow.google.com tải xong hoàn toàn rồi mới đóng.',
    };
}

async function verifyFlowConnection(profileId) {
    const state = await checkFlowSignIn(profileId, { fresh: true });
    if (state === 'signed-in')
        return { ok: true };
    if (state === 'signed-out') {
        const error = signedOutFlowError(profileId);
        return { ok: false, code: error.code, error: `${error.message} ${error.action}` };
    }
    return {
        ok: false,
        code: 'FLOW_UNREACHABLE',
        error: 'Không kiểm tra được kết nối Flow (mạng hoặc proxy) — thử lại sau.',
    };
}
export async function registerProfileRoutes(app) {
    // List all profiles
    app.get('/api/profiles', async (_request, reply) => {
        try {
            const profiles = await profileService.list();
            return reply.send(profiles);
        }
        catch (error) {
            logger.error('Error listing profiles:', error);
            return reply.status(500).send({
                error: 'Failed to list profiles',
                details: error.message || String(error)
            });
        }
    });
    // Get single profile by ID
    // Fetches profile from DB and merges with live cookies from browser partition
    app.get('/api/profiles/:id', async (request, reply) => {
        try {
            const params = z.object({ id: z.string().min(1) }).parse(request.params);
            logger.info(`[Profile] Fetching profile: ${params.id}`);
            const profile = await profileService.getById(params.id);
            if (!profile) {
                logger.info(`[Profile] Profile not found: ${params.id}`);
                return reply.status(404).send({ error: 'Profile not found' });
            }
            // Fetch fresh cookies from browser partition (always up-to-date from warmup)
            try {
                const { getProfileCookiesCompat } = await import('../../utils/profileCookies.js');
                const { cookies: liveCookies, hasCookies } = await getProfileCookiesCompat(profile);
                // Merge live cookies with profile data
                const profileWithCookies = {
                    ...profile,
                    cookies: hasCookies ? liveCookies : profile.cookies || '', // Fallback to DB if partition empty
                };
                logger.info(`[Profile] Fetched profile: ${profile.id}, liveCookies: ${hasCookies}, cookiesLength: ${profileWithCookies.cookies?.length || 0}`);
                return reply.send(profileWithCookies);
            }
            catch (cookieError) {
                // If can't get cookies from partition, return profile with DB cookies
                logger.warn(`[Profile] Could not fetch live cookies, using DB cookies:`, cookieError);
                logger.info(`[Profile] Fetched profile: ${profile.id}, hasCookies: ${!!profile.cookies}`);
                return reply.send(profile);
            }
        }
        catch (error) {
            logger.error('[Profile] Error fetching profile:', error);
            return reply.status(500).send({
                error: 'Failed to fetch profile',
                details: error.message || String(error)
            });
        }
    });
    // Create profile
    app.post('/api/profiles', async (request, reply) => {
        try {
            logger.info('[Profile] Creating profile with payload:', JSON.stringify(request.body, null, 2));
            const payload = profileSchema.parse(request.body);
            logger.info('[Profile] Parsed payload:', JSON.stringify(payload, null, 2));
            const profile = await profileService.create(payload);
            logger.info('[Profile] Created profile:', profile.id);
            // Don't warmup on create — profile has no cookies yet.
            // Warmup will be triggered when cookies are set (via update route)
            // or detected by the health check loop's DB re-scan.
            return reply.code(201).send(profile);
        }
        catch (error) {
            logger.error('[Profile] Error creating profile:', error);
            logger.error('[Profile] Error stack:', error.stack);
            // Check for specific Prisma errors
            if (error.code) {
                logger.error('[Profile] Prisma error code:', error.code);
            }
            return reply.status(500).send({
                error: 'Failed to create profile',
                details: error.message || String(error),
                code: error.code || 'UNKNOWN',
                stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined
            });
        }
    });
    // Update profile
    app.put('/api/profiles/:id', async (request, reply) => {
        try {
            const params = z.object({ id: z.string().min(1) }).parse(request.params);
            const payload = profileSchema.partial().parse(request.body);
            const profile = await profileService.update(params.id, payload);
            return reply.send(profile);
        }
        catch (error) {
            logger.error('Error updating profile:', error);
            return reply.status(500).send({
                error: 'Failed to update profile',
                details: error.message || String(error)
            });
        }
    });
    // Delete profile
    app.delete('/api/profiles/:id', async (request, reply) => {
        try {
            const params = z.object({ id: z.string().min(1) }).parse(request.params);
            // Delete from DB first (fast), then cleanup browser async
            await profileService.delete(params.id);
            return reply.code(204).send();
        }
        catch (error) {
            logger.error('Error deleting profile:', error);
            return reply.status(500).send({
                error: 'Failed to delete profile',
                details: error.message || String(error)
            });
        }
    });
    // Profile pre-flight. Flow retired the Labs token endpoint, so the only
    // authoritative check is whether Flow accepts the stored Google cookies.
    //
    // Returns:
    //   status='fresh'       Flow accepts the stored cookies
    //   status='stale'       Flow shows a signed-out shell
    //   status='no-cookies'  partition empty (never logged in, or wiped)
    //   status='unknown'     profile not found / error reading
    app.get('/api/profiles/:id/auth-status', async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).parse(request.params);
        try {
            const profile = await profileService.getById(params.id);
            if (!profile)
                return reply.code(404).send({ status: 'unknown', error: 'Profile not found' });
            const { getProfileCookiesCompat } = await import('../../utils/profileCookies.js');
            const { hasCookies, parsed } = await getProfileCookiesCompat(profile);
            if (!hasCookies) {
                return reply.send({ status: 'no-cookies', hasLabsSession: false, tokenExpiresAt: null });
            }
            const hasGoogleCookies = hasGoogleSignIn(parsed);
            const signIn = hasGoogleCookies ? await checkFlowSignIn(params.id) : 'signed-out';
            if (signIn === 'unknown')
                return reply.send({ status: 'unknown', hasLabsSession: hasGoogleCookies, tokenExpiresAt: null });
            return reply.send({
                status: signIn === 'signed-in' ? 'fresh' : 'stale',
                hasLabsSession: signIn === 'signed-in',
                tokenExpiresAt: null,
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(`[auth-status] check failed for ${params.id.substring(0, 8)}: ${message}`);
            return reply.code(500).send({ status: 'unknown', error: message });
        }
    });
    // Test profile connection directly against Flow.
    app.post('/api/profiles/:id/test', async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).parse(request.params);
        try {
            const profile = await profileService.getById(params.id);
            if (!profile) {
                reply.code(404).send({ error: 'Profile not found' });
                return;
            }
            // Get cookies from partition
            const { getProfileCookiesCompat } = await import('../../utils/profileCookies.js');
            const { hasCookies, parsed } = await getProfileCookiesCompat(profile);
            if (!hasCookies) {
                reply.code(400).send({
                    success: false,
                    error: 'No cookies found in profile. Please add cookies to test connection.'
                });
                return;
            }
            if (!hasGoogleSignIn(parsed)) {
                const err = signedOutFlowError(profile.id);
                reply.code(400).send({ success: false, ...err });
                return;
            }
            const verdict = await verifyFlowConnection(profile.id);
            if (!verdict.ok) {
                reply.code(400).send({ success: false, code: verdict.code, error: verdict.error });
                return;
            }
            reply.send({ success: true, message: 'Kết nối Flow thành công — cookie của profile còn hiệu lực.' });
        }
        catch (error) {
            reply.code(400).send({
                success: false,
                error: error.message || 'Failed to connect. Please check your cookies.',
            });
        }
    });
    // Compatibility route: verify/refresh the Flow cookie session.
    app.post('/api/profiles/:id/refresh-token', async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).parse(request.params);
        try {
            const profile = await profileService.getById(params.id);
            if (!profile) {
                reply.code(404).send({ error: 'Profile not found' });
                return;
            }
            // Get cookies from partition
            const { getProfileCookiesCompat } = await import('../../utils/profileCookies.js');
            const { hasCookies, parsed } = await getProfileCookiesCompat(profile);
            if (!hasCookies) {
                reply.code(400).send({
                    success: false,
                    error: 'No cookies found in profile'
                });
                return;
            }
            if (!hasGoogleSignIn(parsed)) {
                const err = signedOutFlowError(profile.id);
                reply.code(400).send({ success: false, ...err });
                return;
            }
            const verdict = await verifyFlowConnection(profile.id);
            if (!verdict.ok) {
                reply.code(400).send({ success: false, code: verdict.code, error: verdict.error });
                return;
            }
            reply.send({ success: true, message: 'Phiên Flow còn hiệu lực.', expiresAt: null });
        }
        catch (error) {
            reply.code(400).send({
                success: false,
                error: error.message || 'Failed to refresh token',
            });
        }
    });
    // Save cookies from browser session to profile
    app.post('/api/profiles/:id/save-cookies', async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).parse(request.params);
        const body = z.object({ cookies: z.string().min(1) }).parse(request.body);
        try {
            const profile = await profileService.getById(params.id);
            if (!profile) {
                reply.code(404).send({ error: 'Profile not found' });
                return;
            }
            // Update profile with cookies
            await profileService.update(profile.id, {
                cookies: body.cookies,
            });
            reply.send({
                success: true,
                message: 'Cookies saved successfully!',
            });
        }
        catch (error) {
            reply.code(400).send({
                success: false,
                error: error.message || 'Failed to save cookies',
            });
        }
    });
    // Clone profile — creates N copies with cookies imported into each new Electron partition.
    // Each clone gets a fresh cuid() → unique deterministic fingerprint → distinct
    // Google session score, while sharing the source's login credentials.
    app.post('/api/profiles/:id/clone', async (request, reply) => {
        try {
            const params = z.object({ id: z.string().min(1) }).parse(request.params);
            const body = z.object({
                count: z.number().int().min(1).max(10),
                namePrefix: z.string().max(120).optional(),
            }).parse(request.body);
            const clones = await profileService.cloneProfile(params.id, body.count, {
                namePrefix: body.namePrefix,
            });
            return reply.code(201).send({
                success: true,
                requested: body.count,
                created: clones.length,
                clones,
            });
        }
        catch (error) {
            logger.error('[Profile] Clone failed:', error);
            return reply.status(error.statusCode ?? 500).send({
                error: 'Failed to clone profile',
                details: error.message || String(error),
            });
        }
    });
    // Test proxy connection
    app.post('/api/profiles/test-proxy', async (request, reply) => {
        const body = z.object({
            proxyConfig: z.string().min(1, 'Proxy config is required')
        }).parse(request.body);
        try {
            const { validateProxyFormat, testProxyConnection } = await import('../../utils/proxyUtils.js');
            // Validate format first
            const validation = validateProxyFormat(body.proxyConfig);
            if (!validation.valid) {
                reply.code(400).send({
                    success: false,
                    error: validation.error,
                });
                return;
            }
            // Test actual connection
            const result = await testProxyConnection(body.proxyConfig);
            reply.send(result);
        }
        catch (error) {
            reply.code(400).send({
                success: false,
                error: error.message || 'Failed to test proxy',
            });
        }
    });
    // Get proxy config for a profile (used by Electron browser manager)
    app.get('/api/profiles/:id/proxy', async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).parse(request.params);
        try {
            const proxyConfig = await profileService.getProxyConfig(params.id);
            reply.send({
                success: true,
                proxyConfig,
            });
        }
        catch (error) {
            reply.code(400).send({
                success: false,
                error: error.message || 'Failed to get proxy config',
            });
        }
    });
    // Refresh tier / credits / session expiry for many profiles at once.
    // Static path — keep registered before the /:id variant below.
    // Body: { profileIds?: string[], force?: boolean }
    app.post('/api/profiles/refresh-account-info', async (request, reply) => {
        const body = z
            .object({
            profileIds: z.array(z.string().min(1)).optional(),
            force: z.boolean().optional(),
        })
            .parse(request.body ?? {});
        try {
            const results = await refreshManyProfileAccountInfo(body.profileIds, body.force ?? false);
            return reply.send({ success: true, results });
        }
        catch (err) {
            logger.error('[AccountInfo] batch refresh failed:', err);
            return reply.code(500).send({ success: false, error: err?.message ?? String(err) });
        }
    });
    // Refresh account info for a single profile (per-card ↻ button).
    app.post('/api/profiles/:id/refresh-account-info', async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).parse(request.params);
        const body = z.object({ force: z.boolean().optional() }).parse(request.body ?? {});
        try {
            const info = await refreshProfileAccountInfo(params.id, { force: body.force ?? true });
            return reply.send(info);
        }
        catch (err) {
            logger.error(`[AccountInfo] refresh failed for ${params.id.substring(0, 8)}:`, err);
            return reply.code(500).send({ error: err?.message ?? String(err) });
        }
    });
    app.post('/api/profiles/refresh-all-tokens', async (_request, reply) => {
        try {
            const profiles = await profileService.list();
            const activeProfiles = profiles.filter((p) => p.active);
            if (activeProfiles.length === 0) {
                return reply.send({ success: true, results: [], message: 'No active profiles' });
            }
            const results = [];
            for (const profile of activeProfiles) {
                const verdict = await verifyFlowConnection(profile.id);
                results.push({
                    profileId: profile.id,
                    profileName: profile.name,
                    success: verdict.ok,
                    expiresAt: null,
                    ...(verdict.ok ? {} : {
                        needsRelogin: verdict.code === 'FLOW_SIGNED_OUT',
                        errorCode: verdict.code,
                        error: verdict.error,
                    }),
                });
            }
            const failedProfiles = results.filter(r => !r.success);
            reply.send({
                success: true,
                results,
                summary: { total: results.length, success: results.length - failedProfiles.length, failed: failedProfiles.length },
                failedProfiles,
            });
        }
        catch (error) {
            logger.error('[Profile Routes] refresh-all-tokens failed:', error);
            reply.code(500).send({ success: false, error: error.message || 'Failed to refresh tokens' });
        }
    });
    // Warmup endpoints are kept as no-op stubs so the renderer can call them
    // safely after upgrade. Real warmup is no longer needed in the single-
    // shared-browser model — captcha comes from the user-installed extension.
    app.post('/api/profiles/warmup-all', async (_request, reply) => {
        reply.send({ success: true, message: 'Warmup is a no-op in single-shared-browser mode' });
    });
    // Triggered by Electron after the user closes a profile's Real Chrome.
    // Re-reads the partition after Chrome sync and verifies the session on Flow.
    app.post('/api/profiles/warmup-single', async (request, reply) => {
        const body = z
            .object({ profileId: z.string().min(1), force: z.boolean().optional() })
            .parse(request.body);
        try {
            const { getProfileCookies } = await import('../../utils/profileCookies.js');
            const cookies = await getProfileCookies(body.profileId);
            if (!cookies) {
                return reply.send({
                    success: false,
                    hasAccessToken: false,
                    noCookies: true,
                    error: 'No cookies in partition — user may need to log in again',
                });
            }
            const signIn = await checkFlowSignIn(body.profileId, { fresh: Boolean(body.force) });
            if (signIn === 'signed-in') {
                try {
                    const { genNormalQueueManager } = await import('../genNormal/genNormalQueueManager.js');
                    genNormalQueueManager.clearNeedsRelogin(body.profileId);
                }
                catch (err) {
                    logger.warn(`[warmup-single] could not clear needs-relogin for ${body.profileId.substring(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
                }
                return reply.send({ success: true, hasAccessToken: true, expiresAt: null });
            }
            if (signIn === 'signed-out') {
                return reply.send({
                    success: false,
                    hasAccessToken: false,
                    needsRelogin: true,
                    errorCode: 'FLOW_SIGNED_OUT',
                    error: 'Flow không nhận cookie đã lưu của profile — cần mở Chrome để làm mới phiên',
                });
            }
            return reply.send({
                success: false,
                hasAccessToken: false,
                transient: true,
                error: 'Không kiểm tra được đăng nhập Flow',
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(`[warmup-single] refresh failed for ${body.profileId.substring(0, 8)}: ${message}`);
            // Unclassified = transient as far as the caller is concerned: no
            // needsRelogin flag, so the automation retries instead of opening Chrome.
            return reply.send({ success: false, hasAccessToken: false, transient: true, error: message });
        }
    });
    app.get('/api/profiles/warmup-status', async (_request, reply) => {
        reply.send({
            success: true,
            profiles: [],
            isWarmingUp: false,
            profilesNeedingAuth: [],
            browserLimit: 0,
        });
    });
}
