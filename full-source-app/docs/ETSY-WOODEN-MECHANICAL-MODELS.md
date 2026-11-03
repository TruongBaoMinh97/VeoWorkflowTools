# Workflow Etsy cho mô hình gỗ cơ khí

Preset: `apps/server/src/modules/workflow/presets/etsy-wooden-mechanical-models.workflow.json`.

## Cách dùng

1. Nhập file JSON vào Flow Workflow.
2. Node Folder Input đã trỏ đến `C:/Users/Admin/Downloads/mô hình`. Chọn lại folder nếu ảnh được chuyển sang vị trí khác.
3. Chọn thư mục lưu ở `outputDir` trong node Folder Input, rồi quét và chuẩn bị chạy folder.
4. Kiểm tra 26 job thuộc 4 thư mục sản phẩm. Mỗi ảnh nguồn tạo đúng một ảnh đầu ra bằng Nano Banana Pro.
5. Sau khi chạy, đối chiếu từng ảnh thành phẩm với ảnh nguồn, nhất là bánh răng, lỗ cắt, chi tiết gỗ, phần bị crop và số đo trong ảnh thông tin.

Chế độ `product-images` giữ các ảnh thuộc cùng một sản phẩm trong cùng nhóm đầu ra nhưng gửi từng ảnh riêng lẻ đến model. Master prompt V1.1 từ `mô hình.txt` được lưu trong node Prompt, kèm phần mở đầu về cách xử lý từng job. Ảnh cận cảnh chỉ được thay nền và phải giữ nguyên khung hình, góc nhìn, tỷ lệ chủ thể. Ảnh sản phẩm đầy đủ có thể chỉnh nền, ánh sáng và góc máy nhẹ nếu vẫn giữ đúng cấu trúc. Ảnh chi tiết, ảnh lắp ráp và đồ họa kích thước giữ nguyên vai trò của ảnh nguồn.

Node tạo ảnh được đặt 1:1, một ảnh/job. Có vài ảnh nguồn hơi lệch tỷ lệ vuông; nếu ảnh thành phẩm mất chi tiết ở mép, hãy loại ảnh đó và xử lý riêng theo tỷ lệ nguồn. Việc dùng AI không bảo đảm giữ nguyên từng pixel hay mọi chi tiết cơ khí, vì vậy cần duyệt ảnh trước khi đăng Etsy.
