# Xử lý Google Flow từ chối xác minh — 2026-10-20

Log lần chạy 17:14–17:15 ghi nhận token được tạo thành công, sau đó API tạo ảnh trả
HTTP 403, `reCAPTCHA evaluation failed`, `PUBLIC_ERROR_UNUSUAL_ACTIVITY`.
Backend đang chạy dưới Electron từ `full-source-app`. Việc đổi từ bản đóng gói
sang source và báo browser `connected` chưa giải quyết được phản hồi này.

## Thay đổi

- Phân biệt phản hồi từ chối xác minh với lỗi nội dung, hết quota, lỗi xác thực
  đăng nhập 401, lỗi trình duyệt cục bộ và 429 giới hạn tốc độ.
- Giữ nguyên phản hồi gốc khi truyền lỗi qua lớp tự refresh token; không đổi lỗi
  xác minh thành lỗi cookies hết hạn, kể cả khi xuất hiện sau một lần refresh 401.
- Dừng job/batch bị từ chối xác minh trước nhánh reset/retry của GenNormal.
  Không thay đổi trạng thái job khác hoặc profile khác.
- Hiển thị hướng dẫn kiểm tra đăng nhập/xác minh trực tiếp trên Google Flow;
  nhận diện cả lỗi cũ đang lưu để tránh hướng người dùng sửa prompt sai nguyên nhân.

Đây là sửa xử lý lỗi của VeoWorkflow, không phải sao chép thêm module upstream.
Không thay đổi cơ chế tạo token, dấu vân tay, proxy hoặc cơ chế chống bot của Google.
Không khẳng định tạo ảnh trực tiếp đã hoạt động: phản hồi chấp thuận của Google
chưa được kiểm chứng sau sửa đổi. Các kiểm thử dùng phản hồi giả lập, không gửi
yêu cầu tạo ảnh và không dùng credit.

## Kiểm tra

- `npm test`: 254 kiểm thử, 46 file đều qua, gồm 22 kiểm thử mới cho phân loại lỗi,
  lớp refresh token và dọn batch/hàng đợi.
- `npm run typecheck`: backend và renderer đều qua.
- Build qua `npm run build` trước khi khởi động lại desktop source.

Chỉ source, test và tài liệu thuộc thay đổi này được commit. Không đóng gói
release, sửa bundle trực tiếp, tạo backup hoặc thay dữ liệu người dùng.
