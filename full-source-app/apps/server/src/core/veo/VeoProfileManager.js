/**
 * Veo Profile Manager
 * Centralized profile pool: load + slot acquire/release for queue handlers.
 */
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
export class VeoProfileManager {
    constructor() {
        this._lastAcquireLog = 0;
    }
    async getProfile(profileId) {
        const profile = await prisma.profile.findUnique({ where: { id: profileId } });
        if (!profile)
            return null;
        const usage = await this.getCurrentUsage(profileId);
        const { getProfileCookies } = await import('../../utils/profileCookies.js');
        const cookies = await getProfileCookies(profile.id);
        return {
            id: profile.id,
            name: profile.name,
            accessToken: profile.accessToken,
            cookies,
            maxConcurrency: profile.maxConcurrency,
            maxConcurrentVeo3Jobs: profile.maxConcurrentVeo3Jobs,
            dailyQuota: profile.dailyQuota,
            active: profile.active,
            runningJobs: usage.runningJobs,
            currentDailyUsage: usage.dailyUsage,
            updatedAt: profile.updatedAt,
        };
    }
    async getActiveProfiles() {
        const profiles = await prisma.profile.findMany({
            where: { active: true },
            orderBy: { updatedAt: 'asc' },
        });
        const { getProfileCookies } = await import('../../utils/profileCookies.js');
        return Promise.all(profiles.map(async (profile) => {
            const usage = await this.getCurrentUsage(profile.id);
            const cookies = await getProfileCookies(profile.id);
            return {
                id: profile.id,
                name: profile.name,
                accessToken: profile.accessToken,
                cookies,
                maxConcurrency: profile.maxConcurrency,
                maxConcurrentVeo3Jobs: profile.maxConcurrentVeo3Jobs,
                dailyQuota: profile.dailyQuota,
                active: profile.active,
                runningJobs: usage.runningJobs,
                currentDailyUsage: usage.dailyUsage,
                updatedAt: profile.updatedAt,
            };
        }));
    }
    /**
     * Reserve a slot for a queue job. Returns false to block pickup.
     *
     * Concurrency gates by job type:
     * - upsampling: dynamic sub-limit (1 batch when gen running, 12 idle)
     * - other (currently nothing else routes here in this build): profile.maxConcurrency
     *
     * Gen-normal jobs are managed by `genNormalQueueManager` at the project level
     * and do NOT go through this slot acquisition path.
     */
    async acquireSlot(profileId, jobType) {
        const profile = await this.getProfile(profileId);
        if (!profile || !profile.active) {
            this.maybeLogBlocked(`profile ${profileId.substring(0, 8)}... not available or inactive`, {
                profileExists: !!profile,
                active: profile?.active,
            });
            return false;
        }
        const isUpsamplingJob = jobType === 'video-upsampling' || jobType === 'image-upsampling';
        if (!isUpsamplingJob) {
            if (profile.runningJobs >= profile.maxConcurrency) {
                this.maybeLogBlocked(`profile ${profileId.substring(0, 8)}... at max concurrency`, {
                    runningJobs: profile.runningJobs,
                    maxConcurrency: profile.maxConcurrency,
                });
                return false;
            }
        }
        else {
            // Upscale: when gen is running cap at 1 batch (4 slots); when gen idle allow up to 12.
            const [activeGenJobs, activeUpscaleJobs] = await Promise.all([
                prisma.genNormalJob.count({
                    where: { profileId, status: 'PROCESSING', parentJobId: null },
                }),
                prisma.queueJob.count({
                    where: { profileId, status: 'processing', type: { in: ['video-upsampling', 'image-upsampling'] } },
                }),
            ]);
            const upscaleLimit = activeGenJobs > 0 ? 4 : 12;
            if (activeUpscaleJobs >= upscaleLimit) {
                this.maybeLogBlocked(`profile ${profileId.substring(0, 8)}... upscale at limit (${activeUpscaleJobs}/${upscaleLimit}, gen=${activeGenJobs})`, { activeUpscaleJobs, upscaleLimit, activeGenJobs }, 'debug');
                return false;
            }
        }
        if (!isUpsamplingJob && profile.dailyQuota && (profile.currentDailyUsage ?? 0) >= profile.dailyQuota) {
            this.maybeLogBlocked(`profile ${profileId.substring(0, 8)}... quota exceeded`, {
                usage: profile.currentDailyUsage,
                quota: profile.dailyQuota,
            });
            return false;
        }
        logger.debug(`[VeoProfile] Slot acquired for profile ${profileId}`, {
            runningJobs: profile.runningJobs,
            maxConcurrency: profile.maxConcurrency,
        });
        return true;
    }
    async releaseSlot(profileId) {
        logger.debug(`[VeoProfile] Slot released for profile ${profileId}`);
    }
    /**
     * Aggregate load stats. Called WITHOUT args from admin/stats endpoint
     * (covers all active profiles). The optional `profileIds` arg keeps the
     * signature future-proof for per-project queries.
     */
    async getLoadStats(profileIds) {
        const profiles = profileIds
            ? await Promise.all(profileIds.map((id) => this.getProfile(id)))
            : await this.getActiveProfiles();
        const activeProfiles = profiles.filter((p) => p !== null && p.active);
        if (activeProfiles.length === 0) {
            return {
                totalProfiles: profiles.length,
                activeProfiles: 0,
                totalRunningJobs: 0,
                totalCapacity: 0,
                utilizationPercent: 0,
                availableSlots: 0,
            };
        }
        const totalRunningJobs = activeProfiles.reduce((sum, p) => sum + p.runningJobs, 0);
        const totalCapacity = activeProfiles.reduce((sum, p) => sum + p.maxConcurrency, 0);
        const utilizationPercent = totalCapacity > 0 ? (totalRunningJobs / totalCapacity) * 100 : 0;
        const availableSlots = totalCapacity - totalRunningJobs;
        return {
            totalProfiles: profiles.length,
            activeProfiles: activeProfiles.length,
            totalRunningJobs,
            totalCapacity,
            utilizationPercent: Math.round(utilizationPercent * 100) / 100,
            availableSlots: Math.max(0, availableSlots),
        };
    }
    maybeLogBlocked(reason, ctx, level = 'warn') {
        const now = Date.now();
        if (now - this._lastAcquireLog <= 30000)
            return;
        this._lastAcquireLog = now;
        if (level === 'debug') {
            logger.debug(`[VeoProfile] acquireSlot: ${reason}`, ctx);
        }
        else {
            logger.warn(`[VeoProfile] ⚠️ acquireSlot BLOCKED: ${reason}`, ctx);
        }
    }
    async getCurrentUsage(profileId) {
        const totalRunningJobs = await prisma.queueJob.count({
            where: { profileId, status: 'processing' },
        });
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const [queueDailyUsage, genNormalDailyUsage] = await Promise.all([
            prisma.queueJob.count({
                where: { profileId, status: 'completed', completedAt: { gte: today } },
            }),
            prisma.genNormalJob.count({
                where: { profileId, status: 'COMPLETED', completedAt: { gte: today } },
            }),
        ]);
        return {
            runningJobs: totalRunningJobs,
            dailyUsage: queueDailyUsage + genNormalDailyUsage,
        };
    }
}
export const veoProfileManager = new VeoProfileManager();
