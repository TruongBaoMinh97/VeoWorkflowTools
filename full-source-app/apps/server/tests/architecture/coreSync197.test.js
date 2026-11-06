import { describe, expect, it, vi } from 'vitest';
import { FLOW_RPC, FlowRpcError, parseBatchExecute, parseCreditsPayload } from '../../src/lib/flowBoq.js';
import { WorkflowEngine } from '../../src/modules/workflow/workflow.engine.js';

describe('Veo3Studio 1.9.7 Flow adaptations', () => {
    it('reports the provider rejection details without losing its status', () => {
        const body = `)]}'\n${JSON.stringify([['wrb.fr', FLOW_RPC.credits, null, null, null, [7, 'PUBLIC_ERROR_MODEL_ACCESS_DENIED']]])}`;
        expect(() => parseBatchExecute(body, FLOW_RPC.credits)).toThrow(FlowRpcError);
        try {
            parseBatchExecute(body, FLOW_RPC.credits);
        }
        catch (error) {
            expect(error.status).toBe(7);
            expect(error.message).toContain('PUBLIC_ERROR_MODEL_ACCESS_DENIED');
        }
    });

    it('treats an absent credit count with a valid tier as zero', () => {
        expect(parseCreditsPayload([null, 3, 3, 3])).toMatchObject({
            credits: 0,
            subscriptionCredits: 0,
        });
        expect(() => parseCreditsPayload([null, null])).toThrow(FlowRpcError);
    });

    it('retries only the unsubmitted workflow scene and retains accepted operations', async () => {
        vi.useFakeTimers();
        try {
            const provider = {
                batchAsyncGenerateVideoText: vi.fn()
                    .mockResolvedValueOnce({
                        operations: [{ sceneId: 'accepted', operation: { name: 'op-1' } }],
                        failedItems: [{ sceneId: 'pending', error: new Error('temporary failure') }],
                    })
                    .mockResolvedValueOnce({
                        operations: [{ sceneId: 'pending', operation: { name: 'op-2' } }],
                        failedItems: [],
                    }),
            };
            const request = { requests: [
                { metadata: { sceneId: 'accepted' } },
                { metadata: { sceneId: 'pending' } },
            ] };
            const resultPromise = WorkflowEngine.prototype.submitWorkflowVideoBatch.call({}, provider, 'batchAsyncGenerateVideoText', request);
            await vi.runAllTimersAsync();
            const result = await resultPromise;
            expect(result.operations.map((op) => op.sceneId)).toEqual(['accepted', 'pending']);
            expect(result.failedItems).toEqual([]);
            expect(provider.batchAsyncGenerateVideoText.mock.calls[1][0].requests).toEqual([request.requests[1]]);
        }
        finally {
            vi.useRealTimers();
        }
    });
});
