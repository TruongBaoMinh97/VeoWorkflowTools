import { NonRetryableNodeError } from '../engine/WorkflowNodeError.js';
import { logger } from '../../../lib/logger.js';

const DEFAULT_PLACEHOLDERS = ['{GARMENT_DESCRIPTION}', '{BACKGROUND}', '{SPECIFIC_NEGATIVES}'];
const DEFAULT_KEYS = ['garment_description', 'background', 'specific_negatives'];
const fail = message => { throw new NonRetryableNodeError(`template-merge: ${message}`, { code: 'TEMPLATE_MERGE_INVALID' }); };

export const templateMergeExecutor = {
    type: 'template-merge', version: 1,
    execute({ data, resolved }) {
        const [template, dynamicRaw] = resolved.promptTexts;
        if (typeof template !== 'string' || !template.trim()) fail('không có template — nối Prompt vào cổng Template.');
        if (typeof dynamicRaw !== 'string' || !dynamicRaw.trim()) fail('không có dữ liệu phân tích — nối ChatGPT vào cổng JSON.');
        if (resolved.promptTexts.length > 2) fail('chỉ nhận một template và một JSON phân tích.');
        const placeholders = data.placeholders ?? DEFAULT_PLACEHOLDERS;
        const keys = data.jsonKeys ?? DEFAULT_KEYS;
        if (!Array.isArray(placeholders) || !Array.isArray(keys) || !placeholders.length ||
            placeholders.length !== keys.length || new Set(placeholders).size !== placeholders.length ||
            [...placeholders, ...keys].some(value => typeof value !== 'string' || !value.trim()))
            fail('placeholder và JSON key phải là hai danh sách cùng số phần tử, không để trống hoặc lặp placeholder.');
        let parsed;
        try {
            const cleaned = dynamicRaw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\s*```\s*$/, '');
            parsed = JSON.parse(cleaned);
        } catch {
            logger.warn('[template-merge] JSON không hợp lệ — dùng raw text cho placeholder đầu tiên.');
            parsed = { [keys[0]]: dynamicRaw };
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('JSON phân tích phải là một object.');
        if (parsed.type === 'size_chart') fail('ảnh là bảng size chart, cần workflow bảng size riêng.');
        const values = placeholders.map((placeholder, index) => {
            const value = Object.hasOwn(parsed, keys[index]) ? parsed[keys[index]] : '';
            if (keys[index] === 'specific_negatives' && Array.isArray(value)) {
                if (value.some(item => typeof item !== 'string'))
                    fail('trường specific_negatives chỉ nhận chuỗi hoặc danh sách chuỗi.');
                return value.map(item => item.trim()).filter(Boolean).join('\n');
            }
            if (value != null && typeof value === 'object') fail(`trường ${keys[index]} phải là giá trị đơn.`);
            return value == null ? '' : String(value);
        });
        // Single pass prevents replacement text (including $&, or other placeholders)
        // from being interpreted as a replacement instruction.
        const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(placeholders.slice().sort((a, b) => b.length - a.length).map(escape).join('|'), 'g');
        const textValue = template.replace(pattern, token => values[placeholders.indexOf(token)]);
        return { results: [], textValue, textValues: [textValue] };
    },
};
