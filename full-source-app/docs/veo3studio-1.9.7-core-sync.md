# Đồng bộ core Veo3Studio 1.9.7

Nguồn đối chiếu: bản Veo3Studio 1.9.7 cài tại `C:\Program Files\Veo3Studio` (backend đã build). Đây là thay đổi source VeoWorkflow, chưa phải bản cài hoặc release.

## Đã áp dụng

- Video batch lấy token CAPTCHA ngay trước từng lần gửi. Nếu một hàng thất bại sau khi Flow nhận các hàng trước, service trả lại operation đã nhận và `failedItems` cho các hàng chưa gửi.
- Queue thường chỉ xếp lại `failedItems`; workflow node thử lại đúng các `sceneId` chưa nhận và giữ các operation đã có. Lỗi xác minh rõ ràng vẫn kết thúc, không tự lặp.
- Retry CAPTCHA/403 tạm thời tối đa 12 lần theo mặc định, chờ ít nhất 25 giây; 429 vẫn tối đa 3 lần. Có thể chỉnh trần CAPTCHA bằng `VEO3_RECAPTCHA_MAX_RETRIES`.
- Flow `_reqid` tăng 100000 theo profile và reset sau bootstrap; lỗi RPC giữ chi tiết từ Google; payload credit không có số dư nhưng có tier hợp lệ được đọc là 0.
- `node-tls-client` nâng lên 2.2.0, profile mặc định `chrome_152_psk` và có thể đặt `TLS_CLIENT_PROFILE`. Tên cache thư viện native theo phiên bản mới.

## Chưa áp dụng

- Gửi nhiều video trong một Flow RPC: cần kiểm tra mapping operation với scene trong các node VeoWorkflow trước khi bật.
- Proxy rotation của Veo3Studio: cần kiểm tra cùng proxy manager hiện có, tránh đổi IP giữa bootstrap/token/submit.
- Không bỏ các chốt lỗi xác minh và từ chối quyền model đang có trong VeoWorkflow.
- Bản đóng gói tiếp theo phải mang thư viện native `tls-client-2.2.0-<platform>` tương ứng. Các file native 2.1.0 cũ hiện có trong cây ứng dụng không dùng được với tên cache mới; trong chế độ source, `node-tls-client` sẽ tải bản 2.2.0 nếu chưa có cache. Chưa tạo package theo quy trình source-first.

## Kiểm tra

- `npm run typecheck`: đạt.
- `npm test`: 286/287 đạt; lỗi duy nhất ở `girlsPrincessDressWorkflow.test.js` do thay đổi Etsy/capcut có sẵn ngoài phạm vi đồng bộ.
