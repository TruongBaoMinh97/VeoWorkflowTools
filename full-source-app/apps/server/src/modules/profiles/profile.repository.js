import { prisma } from '../../lib/prisma.js';
export const profileRepository = {
    async list() {
        return prisma.profile.findMany({ orderBy: { createdAt: 'desc' } });
    },
    async getById(id) {
        return prisma.profile.findUnique({ where: { id } });
    },
    async create(data) {
        return prisma.profile.create({ data });
    },
    async update(id, data) {
        return prisma.profile.update({ where: { id }, data });
    },
    async delete(id) {
        // Delete related records first (those without cascade delete or foreign key constraints)
        // These tables don't have proper foreign key constraints, so we need to delete manually
        // GenNormalJob - has profileId but no onDelete constraint
        await prisma.genNormalJob.deleteMany({ where: { profileId: id } });
        // QueueJob - has profileId but no foreign key constraint
        await prisma.queueJob.deleteMany({ where: { profileId: id } });
        // RateLimitLog - has profileId but no foreign key constraint
        await prisma.rateLimitLog.deleteMany({ where: { profileId: id } });
        // ProfileQuota - has profileId but no foreign key constraint
        await prisma.profileQuota.deleteMany({ where: { profileId: id } });
        // (Channel.profileId cleanup removed — the Channel model was dropped
        // by migration 20260524083600_drop_farm_storyboard_workflow along
        // with the rest of the farm-video stack.)
        // Now delete the profile
        // Note:
        // - ScriptProfile, VideoProjectProfile, GenNormalProjectProfile have onDelete: Cascade (auto-delete)
        // - ApiKey, VeoRenderJob have onDelete: SetNull (auto-set to null)
        await prisma.profile.delete({ where: { id } });
    },
};
