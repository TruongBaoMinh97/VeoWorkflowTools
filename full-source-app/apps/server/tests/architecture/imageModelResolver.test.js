import { describe, expect, it } from 'vitest';
import { getAvailableImageModels, normalizeImageModelKey } from '../../src/utils/videoModelResolver.js';

describe('image model catalog', () => {
    it('uses Nano Banana 2.1 and no longer advertises the removed Nano Banana 2 enum', () => {
        expect(getAvailableImageModels()).toContainEqual({ key: 'BELUGA', displayName: '🍌 Nano Banana 2.1' });
        expect(getAvailableImageModels().some(model => model.key === 'NARWHAL')).toBe(false);
    });

    it('migrates saved Nano Banana 2 selections to Nano Banana 2.1', () => {
        expect(normalizeImageModelKey('NARWHAL')).toBe('BELUGA');
        expect(normalizeImageModelKey('BELUGA')).toBe('BELUGA');
    });
});
