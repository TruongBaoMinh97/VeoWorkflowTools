import { describe, expect, it, vi } from 'vitest';
import { FlowGateway } from '../../src/integrations/flow/FlowGateway.js';

describe('FlowGateway', () => {
    it('keeps the workflow contract independent from the concrete Flow client', async () => {
        const client = {
            updateConfig: vi.fn(),
            getCredits: vi.fn(async () => ({ credits: 42 })),
            createProjectAndGetId: vi.fn(async () => 'project-1'),
        };
        const session = { profileId: 'profile-1', locale: 'vi' };
        const gateway = new FlowGateway(session, client);

        expect(client.updateConfig).toHaveBeenCalledWith(session);
        await expect(gateway.getCredits()).resolves.toEqual({ credits: 42 });
        await expect(gateway.createProjectAndGetId('name')).resolves.toBe('project-1');
    });
});
