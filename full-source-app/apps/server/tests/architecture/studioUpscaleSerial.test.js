import { describe, expect, it, vi } from 'vitest';

const findUnique = vi.hoisted(() => vi.fn());
const count = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: { genNormalJob: { findUnique, count } },
}));

import { ImageUpsamplingHandler } from '../../src/core/queue/handlers/ImageUpsamplingHandler.js';
import { VideoUpsamplingHandler } from '../../src/core/queue/handlers/VideoUpsamplingHandler.js';

describe('Studio serial upscale', () => {
  it('caps image upscale at one even when four lanes were configured', async () => {
    findUnique.mockResolvedValueOnce({ project: { imageUpscaleConcurrency: 4, upscaleSerial: true } });
    expect(await ImageUpsamplingHandler.refreshLimitForJob('studio-profile-image', 'image-job')).toBe(1);
    expect(ImageUpsamplingHandler.effectiveLimit('studio-profile-image', 'image-job')).toBe(1);
  });

  it('uses each job setting when Studio and normal projects share a profile', async () => {
    findUnique.mockResolvedValueOnce({ project: { imageUpscaleConcurrency: 4, upscaleSerial: false } });
    findUnique.mockResolvedValueOnce({ project: { imageUpscaleConcurrency: 4, upscaleSerial: true } });
    ImageUpsamplingHandler.inflightByProfile.set('shared-upscale-profile', 1);
    const handler = new ImageUpsamplingHandler();
    try {
      expect(await handler.canProcess({ profileId: 'shared-upscale-profile', data: { genNormalJobId: 'normal-job' } })).toBe(true);
      expect(await handler.canProcess({ profileId: 'shared-upscale-profile', data: { genNormalJobId: 'studio-job' } })).toBe(false);
    } finally {
      ImageUpsamplingHandler.inflightByProfile.delete('shared-upscale-profile');
    }
  });

  it('keeps another video upscale queued until the current one completes', async () => {
    findUnique.mockResolvedValueOnce({ project: { upscaleSerial: true } });
    count.mockResolvedValueOnce(1);
    const handler = new VideoUpsamplingHandler();
    expect(await handler.canProcess({ profileId: 'studio-profile-video', data: { genNormalJobId: 'video-job' } }))
      .toBe(false);
    count.mockResolvedValueOnce(0);
    expect(await handler.canProcess({ profileId: 'studio-profile-video', data: { genNormalJobId: 'video-job' } }))
      .toBe(true);
    vi.clearAllMocks();
  });
});
