# CAPTCHA gắn với profile Flow

Ngày 07/11/2026, một job tạo ảnh lấy được token trên `flow.google.com/about` trong Chrome CAPTCHA riêng nhưng Flow từ chối token với `FLOW_VERIFICATION_REQUIRED` (403). Chrome đó không có cookie đăng nhập; Chrome của profile tạo ảnh đã đăng nhập.

Luồng CDP hiện lấy profile của job trong mutex CAPTCHA, chuyển profile qua route nội bộ có xác thực, rồi mint bằng tab Flow trong Chrome của chính profile đó. Trước khi mint, Electron xác nhận Flow đã đăng nhập. Nếu Chrome chưa đăng nhập hoặc cần xác minh, ứng dụng trả lỗi rõ ràng để người dùng hoàn tất trong Chrome. Lỗi Google từ chối xác minh vẫn dừng job, không bị tự động bỏ qua.

Kiểm tra thực tế: retry đúng job ảnh đã bị 403; token được mint trên `https://flow.google.com/`, RPC ảnh hoàn tất và job chuyển sang `COMPLETED`. Kiểm tra này chỉ xác nhận một profile và một job ảnh; video và các profile khác chưa được kiểm tra trực tiếp.
