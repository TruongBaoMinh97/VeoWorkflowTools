import { prisma } from '../../lib/prisma.js';
export const configRepository = {
    async getAll() {
        const rows = await prisma.appSetting.findMany();
        return rows.map((row) => ({
            key: row.key,
            value: row.value,
        }));
    },
    async upsert(settings) {
        await prisma.$transaction(settings.map((setting) => prisma.appSetting.upsert({
            where: { key: setting.key },
            update: { value: setting.value },
            create: { key: setting.key, value: setting.value },
        })));
    },
};
