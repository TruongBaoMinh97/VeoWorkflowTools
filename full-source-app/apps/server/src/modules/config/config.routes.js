import { appConfigSchema, configService } from './config.service.js';
export async function registerConfigRoutes(app) {
    app.get('/api/config', async () => {
        return configService.getConfig();
    });
    app.put('/api/config', async (request, reply) => {
        const bodySchema = appConfigSchema.partial();
        const body = bodySchema.parse(request.body);
        const changes = {};
        if (body.directories)
            changes.directories = body.directories;
        if (body.defaults)
            changes.defaults = body.defaults;
        const updated = await configService.updateConfig(changes);
        reply.code(200).send(updated);
    });
}
