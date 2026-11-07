# Veo Workflow Tools 1.7.19

- Sửa lỗi đóng gói 1.7.18: backend đã dùng cấu hình TLS của `node-tls-client` 2.2.0 nhưng bản cài lại mang 2.1.0, gây lỗi `does not support TLS_CLIENT_PROFILE=chrome_152_psk` trước khi tạo project hoặc lấy CAPTCHA token.
- Gói 2.2.0 cùng `koffi` và thư viện native Windows tương ứng; quy trình staging kiểm tra phiên bản và `chrome_152_psk` trước khi tạo installer.
- Giữ bản sửa CAPTCHA theo Chrome đã đăng nhập của profile từ 1.7.18.

Nếu Flow yêu cầu xác minh tài khoản, người dùng vẫn cần hoàn tất trong Chrome. Bản cài không chứa database, cookie, token, profile hoặc lịch sử job người dùng.
