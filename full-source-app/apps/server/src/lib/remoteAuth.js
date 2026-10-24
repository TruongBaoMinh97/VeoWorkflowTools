import { logger } from './logger.js';
// Remote auth server for license validation and device tracking
// Production: https://veo3studio.cloud (port 443)
// Development: http://localhost:3001 (local veo_studio_manager)
const REMOTE_AUTH_SERVER = process.env.REMOTE_AUTH_SERVER || 'https://veo3studio.cloud';
logger.info('Remote Auth Server configured', { url: REMOTE_AUTH_SERVER });
/** Avoid spamming logs when remote auth is down in dev */
let devRemoteVerifyUnreachableLogged = false;
/**
 * Remote Authentication Client
 * Verifies tokens and checks licenses with remote auth server
 */
export const remoteAuthClient = {
    /**
     * Verify access token with remote server
     */
    async verifyToken(token) {
        try {
            const response = await fetch(`${REMOTE_AUTH_SERVER}/api/auth/verify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
            });
            if (!response.ok) {
                logger.debug('Token verification failed', { status: response.status });
                return null;
            }
            const data = await response.json();
            return data.user;
        }
        catch (error) {
            const detail = error?.cause instanceof Error ? error.cause.message : error?.cause ?? error?.message;
            if (process.env.NODE_ENV === 'development') {
                if (!devRemoteVerifyUnreachableLogged) {
                    devRemoteVerifyUnreachableLogged = true;
                    logger.warn('Remote auth verify unreachable (dev) — further failures suppressed', {
                        url: `${REMOTE_AUTH_SERVER}/api/auth/verify`,
                        error: error?.message,
                        detail,
                        hint: 'Fix network or set REMOTE_AUTH_SERVER. JWT sessions still work if token exists in local DB.',
                    });
                }
            }
            else {
                logger.error('Remote auth verification error', { error: error.message, detail });
            }
            return null;
        }
    },
    /**
     * Validate license key with remote server
     */
    async validateLicense(licenseKey, machineId, deviceId) {
        try {
            const body = { licenseKey, machineId };
            if (deviceId)
                body.deviceId = deviceId;
            const response = await fetch(`${REMOTE_AUTH_SERVER}/api/license/validate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await response.json();
            return data;
        }
        catch (error) {
            logger.error('License validation error', { error: error.message });
            return {
                valid: false,
                error: 'Failed to connect to license server',
            };
        }
    },
    /**
     * Get machine ID from remote server
     */
    async getMachineId() {
        try {
            const response = await fetch(`${REMOTE_AUTH_SERVER}/api/license/machine-id`);
            const data = await response.json();
            return data.machineId;
        }
        catch (error) {
            logger.error('Failed to get machine ID from remote', { error: error.message });
            // Fallback to local calculation
            const os = await import('os');
            const crypto = await import('crypto');
            const fallback = `${os.hostname()}-${os.platform()}-${os.arch()}`;
            return crypto.createHash('sha256').update(fallback).digest('hex').substring(0, 32);
        }
    },
    /**
     * Login with credentials (redirect to remote server)
     * This should be handled by opening a browser window to remote auth server
     */
    getLoginUrl(callbackUrl) {
        const callback = callbackUrl || 'http://localhost:4000/api/auth/callback';
        return `${REMOTE_AUTH_SERVER}/login?redirect=${encodeURIComponent(callback)}`;
    },
    /**
     * Exchange auth code for token (after OAuth callback)
     */
    async exchangeAuthCode(code) {
        try {
            const response = await fetch(`${REMOTE_AUTH_SERVER}/api/auth/exchange`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
            });
            if (!response.ok) {
                return null;
            }
            return await response.json();
        }
        catch (error) {
            logger.error('Auth code exchange failed', { error: error.message });
            return null;
        }
    },
    /**
     * Refresh access token
     */
    async refreshToken(refreshToken) {
        try {
            const response = await fetch(`${REMOTE_AUTH_SERVER}/api/auth/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refreshToken }),
            });
            if (!response.ok) {
                return null;
            }
            return await response.json();
        }
        catch (error) {
            logger.error('Token refresh failed', { error: error.message });
            return null;
        }
    },
    /**
     * Logout (invalidate tokens)
     */
    async logout(token) {
        try {
            const response = await fetch(`${REMOTE_AUTH_SERVER}/api/auth/logout`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
            });
            return response.ok;
        }
        catch (error) {
            logger.error('Logout failed', { error: error.message });
            return false;
        }
    },
    /**
     * Register device with remote server
     * Sends device info for tracking and license validation
     */
    async registerDevice(params) {
        try {
            const headers = {
                'Content-Type': 'application/json',
            };
            if (params.token) {
                headers['Authorization'] = `Bearer ${params.token}`;
            }
            const registerUrl = `${REMOTE_AUTH_SERVER}/api/license/register-device`;
            logger.info('📱 [REMOTE AUTH] Registering device with remote server', {
                remoteServer: REMOTE_AUTH_SERVER,
                registerUrl,
                machineId: params.machineId,
                deviceName: params.deviceName,
                deviceInfo: params.deviceInfo,
                hasToken: !!params.token,
            });
            const response = await fetch(registerUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    machineId: params.machineId,
                    deviceName: params.deviceName || 'Unknown Device',
                    deviceInfo: params.deviceInfo,
                }),
            });
            logger.info('📡 [REMOTE AUTH] Remote server response', {
                status: response.status,
                statusText: response.statusText,
                ok: response.ok,
                contentType: response.headers.get('content-type'),
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: 'Failed to register device' }));
                logger.warn('❌ [REMOTE AUTH] Device registration failed', {
                    status: response.status,
                    statusText: response.statusText,
                    error: errorData,
                });
                return {
                    success: false,
                    error: errorData.message || `Failed with status ${response.status}`,
                };
            }
            const data = await response.json();
            logger.info('✅ [REMOTE AUTH] Device registered successfully', {
                machineId: params.machineId,
                device: data.device,
            });
            return {
                success: true,
                device: data.device,
            };
        }
        catch (error) {
            logger.error('💥 [REMOTE AUTH] Device registration error - unexpected exception', {
                error: error.message,
                stack: error.stack,
                name: error.name,
                remoteServer: REMOTE_AUTH_SERVER,
            });
            return {
                success: false,
                error: error.message || 'Failed to connect to remote server',
            };
        }
    },
};
