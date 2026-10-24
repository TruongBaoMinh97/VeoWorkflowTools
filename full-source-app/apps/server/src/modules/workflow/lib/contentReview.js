export const CONTENT_REVIEW_MARKER = '[CONTENT_REVIEW_REQUIRED]';
export function needsContentReview(error) {
    const text = typeof error === 'string' ? error : [error?.errorText, error?.message, error?.reason, error?.code].filter(Boolean).join(' ');
    return /CONTENT_REVIEW_REQUIRED|PUBLIC_ERROR_(?:SEXUAL|UNSAFE_GENERATION|MINOR_UPLOAD|AUDIO_FILTERED|VIOLENCE|HATE|HARASSMENT|DANGEROUS|IP_VIOLATION|COPYRIGHT|CELEBRITY|PUBLIC_FIGURE)\b|Nội dung bị từ chối|vi phạm chính sách an toàn|không phù hợp với chính sách của Veo3/i.test(text);
}
export function contentReviewMessage(message) {
    if (String(message).includes(CONTENT_REVIEW_MARKER)) return message;
    return `${CONTENT_REVIEW_MARKER} ${message}\nCần duyệt prompt và ảnh tham chiếu. Không tự gửi lại. Có thể đổi sang ảnh chỉ sản phẩm hoặc pose/bối cảnh catalog trung tính; giữ đúng thiết kế. Lưu thay đổi rồi xác nhận đã duyệt trước khi chạy lại. Các sản phẩm khác tiếp tục xử lý.`;
}
export function assertContentReviewRetry(error, confirmed, running) {
    if (!needsContentReview(error)) return;
    if (running) throw new Error('Cần duyệt: chờ batch kết thúc hoặc huỷ batch trước khi sửa workflow và chạy lại dòng này.');
    if (!confirmed) throw new Error('Cần duyệt: xem lại prompt và ảnh tham chiếu, lưu thay đổi và xác nhận đã duyệt trước khi chạy lại.');
}
