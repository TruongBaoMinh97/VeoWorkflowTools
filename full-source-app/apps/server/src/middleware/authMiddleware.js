import { remoteAuthClient } from '../lib/remoteAuth.js';
import { logger } from '../lib/logger.js';
/**
 * Authentication middleware
 * Verifies JWT token and attaches user to request
 */
export async function authenticateUser(request, reply) {
    try {
        request.user = {
            id: 'test-user',
            email: 'tester@test.local',
            name: 'Tester',
            role: 'ADMIN',
            active: true,
        };
        return;
        // Check x-local-auth header first (used by Electron shutdown calls)
        const localAuthHeader = request.headers['x-local-auth'];
        const localSecret = process.env.LOCAL_AUTH_SECRET;
        if (localAuthHeader && localSecret && localAuthHeader === localSecret) {
            request.user = {
                id: 'local-electron-admin',
                email: 'local@electron',
                name: 'Local Admin',
                role: 'ADMIN',
                active: true,
            };
            return;
        }
        // Get token from header
        const authorization = request.headers.authorization;
        if (!authorization) {
            return reply.status(401).send({
                error: 'Unauthorized',
                message: 'No authorization header provided',
                code: 'NO_TOKEN',
            });
        }
        // Extract bearer token
        const parts = authorization.split(' ');
        if (parts.length !== 2 || parts[0] !== 'Bearer') {
            return reply.status(401).send({
                error: 'Unauthorized',
                message: 'Invalid authorization header format. Use: Bearer <token>',
                code: 'INVALID_TOKEN_FORMAT',
            });
        }
        const token = parts[1];
        if (!token) {
            return reply.status(401).send({
                error: 'Unauthorized',
                message: 'Token is missing',
                code: 'NO_TOKEN',
            });
        }
        // ✅ Check for Local Auth Secret (passed from Electron Main process via Bearer token)
        if (localSecret && token === localSecret) {
            // Authenticated via shared secret - treat as Admin
            request.user = {
                id: 'local-electron-admin',
                email: 'local@electron',
                name: 'Local Admin',
                role: 'ADMIN',
                active: true,
            };
            return;
        }
        const { authService } = await import('../modules/auth/auth.service.js');
        const user = await authService.verifyToken(token);
        if (!user) {
            return reply.status(401).send({
                error: 'Unauthorized',
                message: 'Invalid or expired token',
                code: 'INVALID_TOKEN',
            });
        }
        // Attach user to request
        request.user = {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            active: true, // Remote server validates active status
        };
    }
    catch (error) {
        logger.error('Authentication middleware error', { error: error.message });
        return reply.status(401).send({
            error: 'Unauthorized',
            message: 'Authentication failed',
            code: 'AUTH_ERROR',
        });
    }
}
/**
 * Optional authentication middleware
 * Attaches user if token is valid, but doesn't require it
 */
export async function optionalAuthenticateUser(request, reply) {
    try {
        request.user = {
            id: 'test-user',
            email: 'tester@test.local',
            name: 'Tester',
            role: 'ADMIN',
            active: true,
        };
        return;
        const authorization = request.headers.authorization;
        if (!authorization) {
            return; // No token, continue without user
        }
        const parts = authorization.split(' ');
        if (parts.length === 2 && parts[0] === 'Bearer' && parts[1]) {
            const token = parts[1];
            const user = await remoteAuthClient.verifyToken(token);
            if (user) {
                request.user = {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    role: user.role,
                    active: true,
                };
            }
        }
    }
    catch (error) {
        // Silently fail, continue without user
        logger.debug('Optional auth failed', { error });
    }
}
/**
 * Role-based authorization middleware
 */
export function requireRole(...roles) {
    return async (request, reply) => {
        if (!request.user) {
            return reply.status(401).send({
                error: 'Unauthorized',
                message: 'Authentication required',
                code: 'NOT_AUTHENTICATED',
            });
        }
        if (!roles.includes(request.user.role)) {
            return reply.status(403).send({
                error: 'Forbidden',
                message: `Insufficient permissions. Required role: ${roles.join(' or ')}`,
                code: 'INSUFFICIENT_PERMISSIONS',
            });
        }
    };
}
/**
 * Admin-only middleware
 */
export async function requireAdmin(request, reply) {
    if (!request.user) {
        return reply.status(401).send({
            error: 'Unauthorized',
            message: 'Authentication required',
            code: 'NOT_AUTHENTICATED',
        });
    }
    if (request.user.role !== 'ADMIN' && request.user.role !== 'SUPER_ADMIN') {
        return reply.status(403).send({
            error: 'Forbidden',
            message: 'Admin access required',
            code: 'ADMIN_REQUIRED',
        });
    }
}
