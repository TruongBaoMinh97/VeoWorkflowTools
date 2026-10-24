import { describe, expect, it } from 'vitest';
import {
    buildFlowImageUploadArgs,
    detectFlowImageMimeType,
    normalizeFlowImageUploadResponse,
} from '../../src/services/veo3/flowImageUpload.js';

describe('Flow image upload RPC', () => {
    it('detects MIME from bytes even when a saved extension is misleading', () => {
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
        expect(detectFlowImageMimeType(jpeg, 'image/png')).toBe('image/jpeg');
    });

    it('builds the current maseQ positional payload', () => {
        const args = buildFlowImageUploadArgs({
            projectId: 'project-1',
            imageBytes: 'aW1hZ2U=',
            mimeType: 'image/jpeg',
            fileName: 'character.jpg',
            captchaToken: 'captcha-token',
            seedIds: ['first-id', 'second-id'],
        });
        expect(args).toEqual([
            [null, 22, null, null, null, 'project-1', null, null, null, null, ['captcha-token', 1]],
            'aW1hZ2U=',
            'image/jpeg',
            1,
            null,
            null,
            null,
            null,
            'character.jpg',
            null,
            'FIRST-ID',
            'SECOND-ID',
        ]);
    });

    it('returns the media UUID used by imageInputs', () => {
        const result = normalizeFlowImageUploadResponse([
            ['media-uuid', 'project-1', 'asset-uuid'],
            ['asset-uuid'],
        ]);
        expect(result).toMatchObject({
            name: 'media-uuid',
            media: { name: 'media-uuid' },
            projectId: 'project-1',
            assetId: 'asset-uuid',
        });
    });
});
