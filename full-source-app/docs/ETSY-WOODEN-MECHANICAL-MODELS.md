# Workflow Etsy cho mô hình gỗ cơ khí

Preset: `apps/server/src/modules/workflow/presets/etsy-wooden-mechanical-models.workflow.json`.

## Cách dùng

1. Nhập file JSON vào Flow Workflow.
2. Node Folder Input đã trỏ đến `C:/Users/Admin/Downloads/mô hình`. Chọn lại folder nếu ảnh được chuyển sang vị trí khác.
3. Chọn thư mục lưu ở `outputDir` trong node Folder Input, rồi quét và chuẩn bị chạy folder.
4. Kiểm tra 4 job thuộc 4 thư mục sản phẩm. Mỗi job nhận toàn bộ 6–8 ảnh tham chiếu trong thư mục của mình và tạo một ảnh đầu ra bằng Nano Banana Pro.
5. Sau khi chạy, đối chiếu từng ảnh thành phẩm với ảnh nguồn, nhất là bánh răng, lỗ cắt, chi tiết gỗ, phần bị crop và số đo trong ảnh thông tin.

Chế độ `subfolders` gom ảnh trong mỗi thư mục con thành một bộ tham chiếu, không trộn ảnh của sản phẩm khác. Model được yêu cầu chọn một ảnh toàn sản phẩm làm cơ sở cho bố cục và dùng các ảnh còn lại để đối chiếu cấu trúc, vật liệu, chi tiết cơ khí. Nếu không có ảnh toàn sản phẩm, chỉ tái hiện góc nhìn thực sự có trong bộ ảnh. Master prompt V1.1 từ `mô hình.txt` được lưu trong node Prompt, kèm phần mở đầu cho cách xử lý bộ tham chiếu. Ảnh cận cảnh là bằng chứng chi tiết, không được dùng để bịa thêm phần khuất hoặc ghép một góc nhìn mới.

Node tạo ảnh được đặt 1:1, một ảnh/sản phẩm. Việc dùng AI không bảo đảm giữ nguyên từng pixel hay mọi chi tiết cơ khí, vì vậy cần duyệt ảnh trước khi đăng Etsy.
