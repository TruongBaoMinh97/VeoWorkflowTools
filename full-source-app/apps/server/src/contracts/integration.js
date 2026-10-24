export class IntegrationError extends Error {
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'IntegrationError';
        this.code = code;
        this.retryable = options.retryable ?? false;
        this.details = options.details ?? null;
    }
}

export class FlowGatewayContract {
    updateConfig() { throw new Error('FlowGateway.updateConfig is not implemented'); }
    createProjectAndGetId() { throw new Error('FlowGateway.createProjectAndGetId is not implemented'); }
    getCredits() { throw new Error('FlowGateway.getCredits is not implemented'); }
    uploadImageAndExtractMediaId() { throw new Error('FlowGateway.uploadImageAndExtractMediaId is not implemented'); }
    generateBatchImages() { throw new Error('FlowGateway.generateBatchImages is not implemented'); }
    batchAsyncGenerateVideoText() { throw new Error('FlowGateway.batchAsyncGenerateVideoText is not implemented'); }
    batchAsyncGenerateVideoReferenceImages() { throw new Error('FlowGateway.batchAsyncGenerateVideoReferenceImages is not implemented'); }
    batchAsyncGenerateVideoStartImage() { throw new Error('FlowGateway.batchAsyncGenerateVideoStartImage is not implemented'); }
    batchAsyncGenerateVideoStartAndEndImage() { throw new Error('FlowGateway.batchAsyncGenerateVideoStartAndEndImage is not implemented'); }
    batchAsyncGenerateVideoUpsampleVideo() { throw new Error('FlowGateway.batchAsyncGenerateVideoUpsampleVideo is not implemented'); }
    upsampleImage() { throw new Error('FlowGateway.upsampleImage is not implemented'); }
    pollVideoStatuses() { throw new Error('FlowGateway.pollVideoStatuses is not implemented'); }
}

export class CaptchaGatewayContract {
    ensureReady() { throw new Error('CaptchaGateway.ensureReady is not implemented'); }
    getToken() { throw new Error('CaptchaGateway.getToken is not implemented'); }
    notifySuccess() { throw new Error('CaptchaGateway.notifySuccess is not implemented'); }
    notifyRecaptchaScoreDead() { throw new Error('CaptchaGateway.notifyRecaptchaScoreDead is not implemented'); }
    reset() { throw new Error('CaptchaGateway.reset is not implemented'); }
    status() { throw new Error('CaptchaGateway.status is not implemented'); }
}

export class ProfileExecutionSessionProviderContract {
    getExecutionSession() {
        throw new Error('ProfileExecutionSessionProvider.getExecutionSession is not implemented');
    }
}

export class PromptModelGatewayContract {
    complete() { throw new Error('PromptModelGateway.complete is not implemented'); }
    listModels() { throw new Error('PromptModelGateway.listModels is not implemented'); }
}
