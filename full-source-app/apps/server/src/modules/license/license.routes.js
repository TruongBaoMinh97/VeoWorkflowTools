import { remoteAuthClient } from '../../lib/remoteAuth.js';
import { z } from 'zod';
import { validateData } from '../../lib/validation.js';
import { authenticateUser } from '../../middleware/authMiddleware.js';
import { logger } from '../../lib/logger.js';
const validateLicenseSchema = z.object({
    licenseKey: z.string().min(1, 'License key is required'),
    machineId: z.string().min(1, 'Machine ID is required'),
    deviceId: z.string().min(1).optional(),
});
/**
 * License routes - Proxy to remote license server
 */
export async function registerLicenseRoutes(app) {
    /**
     * GET /api/license/machine-id
     * Get current machine ID
     */
    app.get('/api/license/machine-id', async (request, reply) => {
        const machineId = await remoteAuthClient.getMachineId();
        return reply.send({ machineId });
    });
    /**
     * POST /api/license/validate
     * Validate license with remote server
     */
    app.post('/api/license/validate', async (request, reply) => {
        const body = validateData(validateLicenseSchema, request.body);
        const result = await remoteAuthClient.validateLicense(body.licenseKey, body.machineId, body.deviceId);
        return reply.send(result);
    });
    /**
     * GET /api/license/status
     * Get current license status (requires auth)
     */
    app.get('/api/license/status', {
        onRequest: [authenticateUser],
    }, async (request, reply) => {
        const user = request.user;
        // Remote server returns license info with user verification
        return reply.send({
            userId: user.id,
            email: user.email,
            hasActiveLicense: true, // Validated by remote server during auth
            message: 'License managed by remote server',
        });
    });
    /**
     * POST /api/license/check
     * Quick license check (with auth token)
     * Returns license info embedded in token
     */
    app.post('/api/license/check', {
        onRequest: [authenticateUser],
    }, async (request, reply) => {
        // License info is validated during token verification
        return reply.send({
            valid: true,
            user: request.user,
            timestamp: new Date().toISOString(),
        });
    });
}
