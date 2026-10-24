import { IntegrationError } from '../../contracts/integration.js';
import { appSettingService } from '../../modules/appSettings/appSetting.service.js';

export class OpenAIResponsesClient {
    constructor({ fetchImpl = fetch, getApiKey = async () => process.env.OPENAI_API_KEY?.trim() || await appSettingService.getValue('openai_api_key') } = {}) {
        this.fetchImpl = fetchImpl;
        this.getApiKey = getApiKey;
    }
    async complete(input) {
        const key = await this.getApiKey();
        if (!key) throw new IntegrationError('OPENAI_KEY_MISSING', 'Chưa cấu hình OpenAI API key cho ChatGPT API.', { retryable:false });
        const instructions = input.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
        const messages = input.messages.filter(m => m.role !== 'system').map(m => ({
            role:m.role, content:typeof m.content === 'string' ? [{type:'input_text',text:m.content}] : m.content.map(part =>
                part.type === 'image_url' ? {type:'input_image',image_url:part.image_url.url,detail:'auto'} : {type:'input_text',text:part.text}),
        }));
        let response;
        try {
            response = await this.fetchImpl('https://api.openai.com/v1/responses', {
                method:'POST', headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
                body:JSON.stringify({model:input.model,instructions,input:messages,max_output_tokens:input.maxTokens ?? 4000,store:false,...(input.textFormat ? {text:{format:input.textFormat}} : {})}),
                signal:AbortSignal.timeout(300000),
            });
        } catch {
            throw new IntegrationError('OPENAI_NETWORK', 'Không kết nối được OpenAI hoặc yêu cầu đã hết thời gian chờ.', {retryable:true});
        }
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            const quota = payload?.error?.code === 'insufficient_quota';
            const reason = quota ? 'Hết quota API; kiểm tra billing OpenAI.' : response.status === 401 ? 'API key không hợp lệ.' : response.status === 403 ? 'Tài khoản không có quyền truy cập.' : response.status === 400 || response.status === 404 ? 'Kiểm tra ID model, quyền sử dụng model và đầu vào.' : 'Thử lại sau.';
            throw new IntegrationError(`OPENAI_HTTP_${response.status}`, `OpenAI HTTP ${response.status}: ${reason}`, {retryable:!quota && (response.status === 429 || response.status >= 500 || response.status === 408)});
        }
        if (payload?.status !== 'completed') throw new IntegrationError('OPENAI_INCOMPLETE', 'OpenAI chưa trả kết quả đầy đủ. Kiểm tra giới hạn token hoặc yêu cầu trước khi chạy lại.', {retryable:false});
        const parts = (payload.output ?? []).filter(item => item.type === 'message').flatMap(item => item.content ?? []);
        if (parts.some(part => part.type === 'refusal')) throw new IntegrationError('OPENAI_REFUSAL', 'OpenAI từ chối yêu cầu. Cần duyệt nội dung và ảnh tham chiếu.', {retryable:false});
        const text = parts.filter(part => part.type === 'output_text').map(part => part.text).join('\n').trim();
        if (!text) throw new IntegrationError('OPENAI_EMPTY', 'OpenAI không trả văn bản đầu ra.', {retryable:false});
        return text;
    }
}
export const openAIResponsesClient = new OpenAIResponsesClient();
