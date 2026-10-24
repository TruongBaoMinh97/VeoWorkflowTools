import { adminService } from './admin.service.js';
import { logger } from '../../lib/logger.js';
export async function registerAdminRoutes(app) {
    app.get('/api/admin/stats', async (_request, reply) => {
        try {
            const stats = await adminService.getSystemStats();
            return reply.send(stats);
        }
        catch (error) {
            logger.error('Error getting system stats:', error);
            return reply.status(500).send({ error: 'Failed to get system stats', details: String(error) });
        }
    });
}
