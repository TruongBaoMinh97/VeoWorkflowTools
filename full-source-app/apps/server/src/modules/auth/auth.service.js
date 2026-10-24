import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { remoteAuthClient } from '../../lib/remoteAuth.js';
import { v4 as uuidv4 } from 'uuid';
/**
 * Authentication Service
 * Manages sessions and tokens on the backend server
 */
export class AuthService {
    /**
     * Login with email and password
     * Creates a session and stores tokens in database
     */
    async login(email, password) {
        try {
            // Call remote auth server
            const remoteServer = process.env.REMOTE_AUTH_SERVER || 'https://veo3studio.cloud';
            const loginUrl = `${remoteServer}/api/auth/login`;
            logger.info('🔐 [AUTH SERVICE] Calling remote auth server', {
                email,
                remoteServer,
                loginUrl,
                env: process.env.REMOTE_AUTH_SERVER ? 'custom' : 'default',
                hasPassword: !!password,
            });
            const response = await fetch(loginUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email, password }),
            });
            logger.info('📡 [AUTH SERVICE] Remote server response', {
                status: response.status,
                statusText: response.statusText,
                ok: response.ok,
                contentType: response.headers.get('content-type'),
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ message: 'Login failed' }));
                logger.warn('❌ [AUTH SERVICE] Remote authentication failed', {
                    status: response.status,
                    error: errorData,
                });
                throw new Error(errorData.message || 'Invalid email or password');
            }
            const data = await response.json();
            logger.info('✅ [AUTH SERVICE] Remote authentication successful', {
                userId: data.user?.id,
                email: data.user?.email,
                role: data.user?.role,
                hasAccessToken: !!data.accessToken,
                hasRefreshToken: !!data.refreshToken,
            });
            // Store session in database
            // Note: We need to create or find a local User record first
            // For now, we'll use userId from remote server as the local userId
            // In production, you might want to sync users from remote server
            const expiresAt = new Date(data.expiresAt);
            // Try to find or create local user
            let localUser = await prisma.user.findUnique({
                where: { email: data.user.email },
            });
            if (!localUser) {
                // Create local user record (sync from remote)
                localUser = await prisma.user.create({
                    data: {
                        email: data.user.email,
                        name: data.user.name,
                        role: data.user.role === 'SUPER_ADMIN' || data.user.role === 'ADMIN' ? 'ADMIN' : 'USER',
                        active: true,
                    },
                });
            }
            const session = await prisma.session.create({
                data: {
                    token: data.accessToken,
                    refreshToken: data.refreshToken,
                    expiresAt,
                    userId: localUser.id,
                    ipAddress: undefined, // Can be extracted from request if needed
                    userAgent: undefined, // Can be extracted from request if needed
                },
                include: {
                    user: true,
                },
            });
            logger.info('User logged in', { userId: data.user.id, email: data.user.email, sessionId: session.id });
            return {
                user: data.user,
                accessToken: data.accessToken,
                refreshToken: data.refreshToken,
                expiresAt: data.expiresAt,
                sessionId: session.id,
            };
        }
        catch (error) {
            logger.error('Login failed', { error: error.message, email });
            throw error;
        }
    }
    /**
     * Get current session by token
     */
    async getSessionByToken(token) {
        try {
            const session = await prisma.session.findUnique({
                where: { token },
                include: {
                    user: true,
                },
            });
            if (!session) {
                return null;
            }
            // Check if expired
            if (session.expiresAt < new Date()) {
                // Delete expired session
                await prisma.session.delete({ where: { id: session.id } });
                return null;
            }
            return {
                id: session.id,
                userId: session.userId,
                accessToken: session.token,
                refreshToken: session.refreshToken || '',
                expiresAt: session.expiresAt,
                user: {
                    id: session.user.id,
                    email: session.user.email,
                    name: session.user.name,
                    role: session.user.role === 'ADMIN' ? 'ADMIN' : 'USER', // Map to string
                },
            };
        }
        catch (error) {
            logger.error('Get session failed', { error: error.message });
            return null;
        }
    }
    /**
     * Refresh access token
     */
    async refreshToken(refreshToken) {
        try {
            // Call remote auth server to refresh
            const remoteServer = process.env.REMOTE_AUTH_SERVER || 'https://veo3studio.cloud';
            const response = await fetch(`${remoteServer}/api/auth/refresh`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ refreshToken }),
            });
            if (!response.ok) {
                throw new Error('Invalid or expired refresh token');
            }
            const data = await response.json();
            // Find existing session by refresh token
            const existingSession = await prisma.session.findUnique({
                where: { refreshToken },
                include: { user: true },
            });
            if (!existingSession) {
                throw new Error('Session not found');
            }
            // Update session with new tokens
            const expiresAt = new Date(data.expiresAt);
            const session = await prisma.session.update({
                where: { id: existingSession.id },
                data: {
                    token: data.accessToken,
                    refreshToken: data.refreshToken,
                    expiresAt,
                },
                include: {
                    user: true,
                },
            });
            logger.info('Token refreshed', { userId: session.userId, sessionId: session.id });
            return {
                user: {
                    id: session.user.id,
                    email: session.user.email,
                    name: session.user.name,
                    role: session.user.role,
                },
                accessToken: data.accessToken,
                refreshToken: data.refreshToken,
                expiresAt: data.expiresAt,
                sessionId: session.id,
            };
        }
        catch (error) {
            logger.error('Refresh token failed', { error: error.message });
            throw error;
        }
    }
    /**
     * Logout - delete session
     */
    async logout(token) {
        try {
            // Delete session from database
            await prisma.session.deleteMany({
                where: { token },
            });
            // Also try to logout from remote server
            try {
                await remoteAuthClient.logout(token);
            }
            catch (error) {
                // Ignore remote logout errors
                logger.warn('Remote logout failed', { error });
            }
            logger.info('User logged out', { token: token.substring(0, 10) + '...' });
        }
        catch (error) {
            logger.error('Logout failed', { error: error.message });
            throw error;
        }
    }
    /**
     * Get current user from session
     */
    async getCurrentUser(token) {
        const session = await this.getSessionByToken(token);
        return session?.user || null;
    }
    /**
     * Verify token and return user
     */
    async verifyToken(token) {
        // First check local session
        const session = await this.getSessionByToken(token);
        if (session) {
            return session.user;
        }
        // If not in local DB, verify with remote server
        const user = await remoteAuthClient.verifyToken(token);
        if (!user) {
            return null;
        }
        // Create session if valid
        try {
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
            await prisma.session.create({
                data: {
                    token,
                    userId: user.id,
                    expiresAt,
                },
            });
        }
        catch (error) {
            // Session might already exist, ignore
        }
        return {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
        };
    }
    /**
     * Clean up expired sessions
     */
    async cleanupExpiredSessions() {
        try {
            const result = await prisma.session.deleteMany({
                where: {
                    expiresAt: {
                        lt: new Date(),
                    },
                },
            });
            if (result.count > 0) {
                logger.info('Cleaned up expired sessions', { count: result.count });
            }
            return result.count;
        }
        catch (error) {
            logger.error('Cleanup expired sessions failed', { error: error.message });
            return 0;
        }
    }
}
export const authService = new AuthService();
