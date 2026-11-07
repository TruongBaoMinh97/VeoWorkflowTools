# Veo Workflow Tools 1.7.18

- Cập nhật lõi Flow tạo video và phiên TLS từ Veo3Studio 1.9.7.
- Tải reCAPTCHA Enterprise khi trang Flow chưa có hàm `execute`.
- Lấy CAPTCHA trong Chrome đã đăng nhập của đúng profile đang tạo ảnh/video; dừng sớm khi profile cần đăng nhập hoặc xác minh.
- Giữ cơ chế dừng job khi Google thực sự từ chối xác minh; không bỏ qua giới hạn 429.

Đã chạy lại một job ảnh từng bị `FLOW_VERIFICATION_REQUIRED`: token lấy trên `https://flow.google.com/` của profile và job hoàn tất. Chưa kiểm tra trực tiếp job video hoặc mọi profile.

Installer không chứa database, cookie, token, profile hoặc lịch sử job người dùng.
