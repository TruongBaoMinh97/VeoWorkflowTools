import { z } from 'zod';
import { validateData } from '../../lib/validation.js';
import { appSettingService } from './appSetting.service.js';
const keyParamSchema = z.object({ key: z.string().min(1) });
const setBodySchema = z.object({ value: z.string().min(1) });
export async function registerAppSettingRoutes(app) {
    app.get('/api/app-settings', async () => {
        const meta = appSettingService.listMeta();
        const states = await Promise.all(meta.map((m) => appSettingService.get(m.key)));
        return states;
    });
    app.get('/api/app-settings/:key', async (request) => {
        const { key } = validateData(keyParamSchema, request.params);
        return appSettingService.get(key);
    });
    app.put('/api/app-settings/:key', async (request) => {
        const { key } = validateData(keyParamSchema, request.params);
        const body = validateData(setBodySchema, request.body);
        return appSettingService.set(key, body.value);
    });
    app.delete('/api/app-settings/:key', async (request) => {
        const { key } = validateData(keyParamSchema, request.params);
        return appSettingService.clear(key);
    });
}
