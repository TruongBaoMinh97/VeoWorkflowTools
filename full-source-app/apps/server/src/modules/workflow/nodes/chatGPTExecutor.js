import { aiPromptExecutor } from './aiPromptExecutor.js';
import { openAIResponsesClient } from '../../../integrations/ai/OpenAIResponsesClient.js';
import { NonRetryableNodeError } from '../engine/WorkflowNodeError.js';
export const chatGPTExecutor = {
    type:'chatgpt', version:1,
    execute(context) {
        if (!String(context.data.model ?? '').trim()) throw new NonRetryableNodeError('ChatGPT API: nhập ID model OpenAI trước khi chạy.', {code:'OPENAI_MODEL_REQUIRED'});
        return aiPromptExecutor.execute({...context, promptClient:openAIResponsesClient});
    },
};
