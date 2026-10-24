# Veo Workflow Tools 1.7.15

- Chuyển nguồn cập nhật sang repo public TruongBaoMinh97/VeoWorkflowTools. Máy nhận không cần GitHub CLI hoặc token GitHub.
- Batch và Veo3 Gen dùng chung cửa gửi ảnh theo profile: tối đa 2 ảnh đang xử lý, cách lượt bắt đầu ít nhất 5 giây.
- Giữ thời gian nghỉ khi gặp giới hạn tốc độ; dừng lượt chờ khi Google yêu cầu xác minh.
- Giữ ảnh đã thành công trong cùng phiên retry của workflow.

## Cài trên máy khác

Tải `Veo-Workflow-Tools-Setup-1.7.15-x64.exe`, đóng bản portable đang mở rồi chạy bộ cài. Mở bằng shortcut **Veo Workflow Tools** do bộ cài tạo.

Những lần sau, app kiểm tra GitHub Releases và hiển thị thông báo tải bản mới. Tải xong chọn **Khởi động lại** để áp dụng. Chỉ push source lên GitHub chưa tạo bản cập nhật: cần phát hành Setup, blockmap và latest.yml cùng phiên bản.

Gói cài không kèm profile, cookie, API key, lịch sử job hoặc database phát triển. Google vẫn có thể yêu cầu xác minh khi sử dụng.
