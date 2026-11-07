# Sửa lỗi CDP `GRECAPTCHA_UNAVAILABLE` ngày 7/11/2026

Log của bản cài 1.7.17 ghi 16 lần tạo token `IMAGE_GENERATION` thất bại từ 15:04:50 đến 15:13:42, trên 7 job. Trình duyệt CAPTCHA chạy được và nhiều lần reset, nhưng `flow.google.com` không có `grecaptcha.enterprise.execute`; yêu cầu tạo ảnh dừng trước khi gửi Flow. Không có HTTP 403 hoặc 429 thực trong chuỗi lỗi này.

Nhánh extension đã nạp reCAPTCHA Enterprise khi trang Flow không tự nạp. Nhánh CDP giờ làm tương tự: trước tiên tìm `execute` trong các frame; nếu không có, nạp SDK chính thức của Google bằng site key đã cấu hình, dùng CSP nonce và Trusted Types của trang Flow. Chỉ thực hiện trên origin `https://flow.google.com`, chỉ thêm một script trên mỗi trang, và ghi trạng thái SDK/page/frame khi vẫn không tìm thấy hàm. Lỗi từ Electron được giữ là lỗi tạo token thay vì luôn gắn nhãn mất kết nối bridge.

Kiểm tra: TypeScript Electron build và backend/renderer typecheck đạt. Test CAPTCHA đạt. Thử trực tiếp trên Chrome 156 với trang Flow trong hồ sơ Chrome tách biệt: SDK tải xong, `execute` xuất hiện và tạo được token `IMAGE_GENERATION` (không gửi job hoặc ghi token ra log). Bản desktop 1.7.17 đang cài chưa được thay đổi; cần package/release riêng khi được yêu cầu.
