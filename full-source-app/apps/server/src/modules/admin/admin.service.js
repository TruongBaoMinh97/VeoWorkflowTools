import { prisma } from '../../lib/prisma.js';
import { veoProfileManager } from '../../core/veo/VeoProfileManager.js';
export const adminService = {
    async getSystemStats() {
        const [totalJobs, jobsByStatus, jobs24h, totalProfiles, activeProfiles, loadStats] = await Promise.all([
            prisma.genNormalJob.count(),
            prisma.genNormalJob.groupBy({ by: ['status'], _count: true }),
            prisma.genNormalJob.count({
                where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
            }),
            prisma.profile.count(),
            prisma.profile.count({ where: { active: true } }),
            veoProfileManager.getLoadStats(),
        ]);
        const completedCount = jobsByStatus.find((s) => s.status === 'COMPLETED')?._count || 0;
        const failedCount = jobsByStatus.find((s) => s.status === 'FAILED')?._count || 0;
        const totalFinished = completedCount + failedCount;
        const successRate = totalFinished > 0 ? (completedCount / totalFinished) * 100 : 0;
        return {
            jobs: {
                total: totalJobs,
                byStatus: Object.fromEntries(jobsByStatus.map((s) => [s.status, s._count])),
                last24Hours: jobs24h,
                successRate: Math.round(successRate * 100) / 100,
            },
            profiles: {
                total: totalProfiles,
                active: activeProfiles,
                utilizationPercent: loadStats.utilizationPercent,
            },
        };
    },
};
