# Veo Workflow Tools 1.7.17

- Phân biệt lỗi trình duyệt không lấy được CAPTCHA token với lỗi Google từ chối token; lùi thời gian thử lại theo profile và reset trình duyệt CAPTCHA sớm hơn.
- Thử lại lỗi Flow 403 tạm thời, vẫn dừng khi Google báo rõ tài khoản không có quyền model hoặc cần xác minh.
- Sửa batch video gặp 429 không có nội dung lỗi thô bị đánh dấu thất bại ngay; giữ đường chờ và thử lại.

Google vẫn có thể trả 429 khi cùng profile gửi quá nhiều yêu cầu. Lỗi `FLOW_SIGNED_OUT` do trang Flow thiếu `WIZ_global_data` không nằm trong bản sửa này.

Gói cài không chứa profile, cookie, API key, lịch sử job hoặc database người dùng.
