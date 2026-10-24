import { remoteAuthClient } from '../../lib/remoteAuth.js';
import { authService } from './auth.service.js';
import { z } from 'zod';
import { validateData } from '../../lib/validation.js';
import { authenticateUser } from '../../middleware/authMiddleware.js';
import { logger } from '../../lib/logger.js';
const exchangeCodeSchema = z.object({
    code: z.string().min(1, 'Auth code is required'),
});
const refreshTokenSchema = z.object({
    refreshToken: z.string().min(1, 'Refresh token is required'),
});
const loginSchema = z.object({
    email: z.string().email('Invalid email format'),
    password: z.string().min(1, 'Password is required'),
});
/**
 * Authentication routes - Proxy to remote auth server
 */
export async function registerAuthRoutes(app) {
    /**
     * POST /api/auth/login
     * Login with email and password
     * Creates session and stores tokens in database
     */
    app.post('/api/auth/login', async (request, reply) => {
        const body = validateData(loginSchema, request.body);
        logger.info('🔐 [AUTH ROUTES] Login request received', {
            email: body.email,
            hasPassword: !!body.password,
        });
        try {
            const result = await authService.login(body.email, body.password);
            logger.info('✅ [AUTH ROUTES] Auth service login successful', {
                userId: result.user?.id,
                email: result.user?.email,
                role: result.user?.role,
            });
            // Get admins if super admin (from remote server response)
            let admins = undefined;
            try {
                const remoteServer = process.env.REMOTE_AUTH_SERVER || 'https://veo3studio.cloud';
                const loginUrl = `${remoteServer}/api/auth/login`;
                logger.info('📡 [AUTH ROUTES] Fetching admins from remote server', {
                    remoteServer,
                    loginUrl,
                    env: process.env.REMOTE_AUTH_SERVER ? 'custom' : 'default',
                });
                const remoteResponse = await fetch(loginUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: body.email, password: body.password }),
                });
                logger.info('📡 [AUTH ROUTES] Remote admins response', {
                    status: remoteResponse.status,
                    ok: remoteResponse.ok,
                });
                if (remoteResponse.ok) {
                    const remoteData = await remoteResponse.json();
                    admins = remoteData.admins;
                    logger.info('✅ [AUTH ROUTES] Admins fetched successfully', {
                        adminsCount: admins?.length || 0,
                    });
                }
            }
            catch (error) {
                logger.warn('⚠️ [AUTH ROUTES] Failed to fetch admins (non-critical)', {
                    error: error.message,
                });
                // Ignore error, admins is optional
            }
            return reply.send({
                user: result.user,
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
                expiresAt: result.expiresAt,
                sessionId: result.sessionId,
                admins, // For super admin
            });
        }
        catch (error) {
            logger.error('❌ [AUTH ROUTES] Login error', {
                error: error.message,
                email: body.email,
                stack: error.stack,
            });
            const errorMessage = error.message || 'Email hoặc mật khẩu không hợp lệ.';
            return reply.status(401).send({
                error: 'Login Failed',
                message: errorMessage,
            });
        }
    });
    /**
     * GET /api/auth/login-url
     * Get remote login URL
     */
    app.get('/api/auth/login-url', async (request, reply) => {
        const { callbackUrl } = request.query;
        const loginUrl = remoteAuthClient.getLoginUrl(callbackUrl);
        return reply.send({
            loginUrl,
            message: 'Open this URL in browser to login',
        });
    });
    /**
     * POST /api/auth/exchange
     * Exchange auth code for tokens (after OAuth callback)
     */
    app.post('/api/auth/exchange', async (request, reply) => {
        const body = validateData(exchangeCodeSchema, request.body);
        const result = await remoteAuthClient.exchangeAuthCode(body.code);
        if (!result) {
            return reply.status(401).send({
                error: 'Unauthorized',
                message: 'Invalid or expired auth code',
            });
        }
        return reply.send(result);
    });
    /**
     * POST /api/auth/refresh
     * Refresh access token
     * Updates session in database
     */
    app.post('/api/auth/refresh', async (request, reply) => {
        const body = validateData(refreshTokenSchema, request.body);
        try {
            const result = await authService.refreshToken(body.refreshToken);
            return reply.send({
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
                expiresAt: result.expiresAt,
                user: result.user,
            });
        }
        catch (error) {
            logger.error('Refresh token error', { error: error.message });
            return reply.status(401).send({
                error: 'Unauthorized',
                message: error.message || 'Invalid or expired refresh token',
            });
        }
    });
    /**
     * POST /api/auth/logout
     * Logout - delete session from database
     */
    app.post('/api/auth/logout', {
        onRequest: [authenticateUser],
    }, async (request, reply) => {
        const authorization = request.headers.authorization;
        if (authorization) {
            const token = authorization.split(' ')[1];
            if (token) {
                try {
                    await authService.logout(token);
                }
                catch (error) {
                    logger.error('Logout error', { error: error.message });
                }
            }
        }
        return reply.send({ success: true, message: 'Logged out successfully' });
    });
    /**
     * GET /api/auth/me
     * Get current user info (from session)
     */
    app.get('/api/auth/me', {
        onRequest: [authenticateUser],
    }, async (request, reply) => {
        // User already verified by middleware
        // Try to get from session for more complete info
        const authorization = request.headers.authorization;
        if (authorization) {
            const token = authorization.split(' ')[1];
            if (token) {
                const session = await authService.getSessionByToken(token);
                if (session) {
                    return reply.send(session.user);
                }
            }
        }
        return reply.send(request.user);
    });
    /**
     * POST /api/auth/register-device
     * Register device info after login
     */
    app.post('/api/auth/register-device', {
        onRequest: [authenticateUser],
    }, async (request, reply) => {
        const body = request.body;
        if (!body.machineId) {
            return reply.status(400).send({
                error: 'Bad Request',
                message: 'Machine ID is required',
            });
        }
        try {
            // Extract token from Authorization header
            const token = request.headers.authorization?.split(' ')[1];
            // Get device info from OS
            const os = await import('os');
            const deviceInfo = {
                platform: os.platform(),
                arch: os.arch(),
                hostname: os.hostname(),
                osVersion: os.release(),
            };
            // Register device with remote server
            const result = await remoteAuthClient.registerDevice({
                machineId: body.machineId,
                deviceName: body.deviceName || `${os.hostname()}-${os.platform()}`,
                deviceInfo,
                token,
            });
            if (!result.success) {
                return reply.status(400).send({
                    error: 'Failed to register device',
                    message: result.error || 'Unknown error',
                });
            }
            return reply.send({
                success: true,
                device: result.device,
            });
        }
        catch (error) {
            logger.error('Register device error', { error: error.message });
            return reply.status(500).send({
                error: 'Internal Server Error',
                message: error.message || 'Failed to register device',
            });
        }
    });
    /**
     * GET /api/auth/verify
     * Verify token and return session info
     */
    app.get('/api/auth/verify', async (request, reply) => {
        const authorization = request.headers.authorization;
        if (!authorization) {
            return reply.status(401).send({
                valid: false,
                error: 'No authorization header',
            });
        }
        const token = authorization.split(' ')[1];
        if (!token) {
            return reply.status(401).send({
                valid: false,
                error: 'No token provided',
            });
        }
        try {
            const user = await authService.verifyToken(token);
            if (!user) {
                return reply.status(401).send({
                    valid: false,
                    error: 'Invalid or expired token',
                });
            }
            return reply.send({
                valid: true,
                user,
                timestamp: new Date().toISOString(),
            });
        }
        catch (error) {
            logger.error('Verify token error', { error: error.message });
            return reply.status(401).send({
                valid: false,
                error: error.message || 'Token verification failed',
            });
        }
    });
    /**
     * GET /api/auth/callback
     * OAuth callback handler (receives code from remote server)
     */
    app.get('/api/auth/callback', async (request, reply) => {
        const { code, error } = request.query;
        if (error) {
            return reply.status(400).send({
                error: 'OAuth Error',
                message: error,
            });
        }
        if (!code) {
            return reply.status(400).send({
                error: 'Bad Request',
                message: 'Missing auth code',
            });
        }
        // Exchange code for tokens
        const result = await remoteAuthClient.exchangeAuthCode(code);
        if (!result) {
            return reply.status(401).send({
                error: 'Unauthorized',
                message: 'Failed to exchange auth code',
            });
        }
        // Return HTML page that sends tokens to Electron renderer
        // This is typically shown in a modal window
        return reply.type('text/html').send(`
<!DOCTYPE html>
<html>
<head>
  <title>Login Successful</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .container {
      text-align: center;
      padding: 2rem;
      background: rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(10px);
      border-radius: 20px;
      box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
    }
    h1 { margin: 0 0 1rem 0; }
    p { margin: 0.5rem 0; opacity: 0.9; }
    .checkmark {
      font-size: 4rem;
      animation: bounce 0.5s ease;
    }
    @keyframes bounce {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.2); }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">✓</div>
    <h1>Login Successful!</h1>
    <p>You can close this window now.</p>
  </div>
  <script>
    // Send auth data to Electron renderer if in Electron environment
    if (window.electronAPI) {
      window.electronAPI.sendAuthData(${JSON.stringify(result)});
    }

    // Auto-close after 2 seconds
    setTimeout(() => {
      window.close();
    }, 2000);
  </script>
</body>
</html>
    `);
    });
}
