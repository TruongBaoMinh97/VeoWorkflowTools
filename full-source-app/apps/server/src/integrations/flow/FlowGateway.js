import { FlowGatewayContract } from '../../contracts/integration.js';
import { Veo3Service } from '../../services/veo3/veo3Service.js';

/**
 * Workflow-facing Flow adapter. Google-specific payloads remain behind this
 * boundary while the workflow engine depends on a stable gateway contract.
 */
export class FlowGateway extends FlowGatewayContract {
    constructor(session, client = new Veo3Service()) {
        super();
        this.client = client;
        this.updateConfig(session);
    }

    updateConfig(config) { return this.client.updateConfig(config); }
    createProjectAndGetId(...args) { return this.client.createProjectAndGetId(...args); }
    getCredits(...args) { return this.client.getCredits(...args); }
    uploadImageAndExtractMediaId(...args) { return this.client.uploadImageAndExtractMediaId(...args); }
    generateBatchImages(...args) { return this.client.generateBatchImages(...args); }
    batchAsyncGenerateVideoText(...args) { return this.client.batchAsyncGenerateVideoText(...args); }
    batchAsyncGenerateVideoReferenceImages(...args) { return this.client.batchAsyncGenerateVideoReferenceImages(...args); }
    batchAsyncGenerateVideoStartImage(...args) { return this.client.batchAsyncGenerateVideoStartImage(...args); }
    batchAsyncGenerateVideoStartAndEndImage(...args) { return this.client.batchAsyncGenerateVideoStartAndEndImage(...args); }
    batchAsyncGenerateVideoUpsampleVideo(...args) { return this.client.batchAsyncGenerateVideoUpsampleVideo(...args); }
    upsampleImage(...args) { return this.client.upsampleImage(...args); }
    pollVideoStatuses(...args) { return this.client.pollVideoStatuses(...args); }
}

export const flowGatewayFactory = {
    create(session) {
        return new FlowGateway(session);
    },
};
