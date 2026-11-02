# Đối chiếu gen video trong Veo3 Gen — 30/10/2026

## Kết luận từ bằng chứng

Lỗi video đã ghi nhận trong VeoWorkflow ngày 21/10/2026 là Google từ chối quyền sử dụng model `veo_3_1_t2v_lite_low_priority` (`PUBLIC_ERROR_MODEL_ACCESS_DENIED`). Lượt thành công của Veo3Studio 1.8.9 ngày 25/10 dùng model khác: `veo_3_1_t2v_lite`. Đây không phải phép thử cùng model/cùng tài khoản, nên không thể dùng hai lượt này để kết luận toàn bộ chức năng video của VeoWorkflow hỏng.

Source hiện tại của VeoWorkflow đã có luồng Flow BOQ video tương ứng Veo3Studio 1.8.9. Các helper video/upload, transport BOQ, bảng RPC và captcha manager trùng upstream sau khi bỏ khác biệt CRLF/source-map. Chưa tìm thấy lượt thử video mới của VeoWorkflow sau khi chuyển sang BOQ trong log còn lưu; chưa thể xác nhận nguyên nhân của một lỗi hiện tại trên máy khác.

## Phạm vi và phiên bản

- Upstream cài tại `C:/Users/Admin/AppData/Local/Programs/Veo3Studio`, phiên bản 1.8.9.
- Baseline audit: 1.8.5. Baseline này chưa được promote sau đợt sync chọn lọc 1.8.9; chênh lệch audit không đồng nghĩa toàn bộ mã hiện tại đều cũ.
- VeoWorkflow source: `full-source-app/apps/server/src`.
- Shortcut `Veo Workflow Story.lnk` trên máy này mở `full-release/Veo Workflow Tools-win32-x64/Veo Workflow Tools.exe`; package bên trong báo 1.7.14. Runtime video ở đây đã có `submitVideoViaFlow` và tương đương source về phần video.
- Output 1.7.16 có package version 1.7.16 và cùng luồng video BOQ; tăng version không tự thay đổi quyền sử dụng model của tài khoản Google.
- Không app nào đang chạy tại thời điểm đối chiếu.

Audit sinh báo cáo tại `core-sync/reports/1.8.9-20261030-014850/` và snapshot tại `core-sync/snapshots/1.8.9-20261030-014850/`.

## Log trực tiếp

Backend của cả hai app có dữ liệu trong `C:/Users/Admin/AppData/Roaming/veo3studio/logs/app.log`; không phân biệt app chỉ bằng tên thư mục log. Đã gắn các sự kiện với bản ghi `startup diag.appVersion` trước đó.

| Bản app / thời gian địa phương | Cấu hình và kết quả | Vị trí trong app.log |
| --- | --- | --- |
| VeoWorkflow 1.7.13, 21/10 19:18:55 | Text-to-Video, 16:9, `veo_3_1_t2v_lite_low_priority` | 45801–45823 |
| Cùng lượt, 19:18:57 | REST video cũ trả HTTP 403, `PUBLIC_ERROR_MODEL_ACCESS_DENIED`; job FAILED | 45833–45853 |
| Veo3Studio 1.8.9, 25/10 01:42:15 | Text-to-Video, 16:9, `veo_3_1_t2v_lite` | 56048–56070 |
| Cùng lượt, 01:42:22 → 01:43:05 | Có operation/workflow ID, polling COMPLETED và có URL video | 56083–56087 |

Khoảng từ lúc Veo3Studio bắt đầu submit (01:42:17) đến COMPLETED là 48 giây. Log không chứng minh file đã được tải hoặc video đã được xem.

Các database đang còn lưu của hai app không có job video; chỉ có job IMAGE_GENERATION. Log cho thấy các job video cũ đã bị xóa/thay bằng batch ảnh. Không thay đổi database trong quá trình kiểm tra.

## So sánh chức năng và hợp đồng API

| Phần | Veo3Studio 1.8.9 | VeoWorkflow hiện tại | Đánh giá |
| --- | --- | --- | --- |
| Text-to-Video | BOQ `YhhmEf` | Cùng RPC/payload | Không phát hiện lệch |
| Image-to-Video | BOQ `eb1hJf` | Cùng RPC/payload | Không phát hiện lệch |
| Khung đầu + cuối | BOQ `nprQif` | Cùng RPC/payload | Không phát hiện lệch |
| Video từ ảnh tham chiếu / giọng preset | BOQ `MZZa6b` | Cùng RPC/payload | Không phát hiện lệch |
| Upload ảnh | BOQ `maseQ`, UUID media | Helper trùng upstream | Không phát hiện lệch |
| Auth / session / proxy | Cookie Flow, bootstrap BOQ, bảng RPC | Transport BOQ, registry, profile-cookie helper và proxy helper trùng | Không có bằng chứng thiếu migration video trong runtime shortcut chính |
| Poll + đọc URL | `jwpduf` + `as29s` | Cùng parser/helper và các hàm video service | Không phát hiện lệch |
| Danh sách model | Lite thường và Lite Lower Priority là hai key khác nhau | Cùng ánh xạ video | Lượt lỗi và lượt thành công chọn model khác nhau |
| Chống gửi trùng video đang submit | Có Map `submittingJobs` và guard `isSubmitting` | Chưa có guard này | Khác biệt cần thích nghi, có nguy cơ gửi/trừ credit trùng; chưa có bằng chứng là nguyên nhân của lượt lỗi đầu tiên |
| Chống tạo/ghi kết quả upscale trùng | Có khóa theo project, kiểm tra child và parent | Thiếu một số guard | Ảnh hưởng upscale/tải lặp, không giải thích việc submit video đầu tiên bị từ chối |
| Xử lý lỗi xác minh | Luồng retry/recovery upstream | Thêm chính sách dừng các lỗi xác minh nhận diện được | Giữ chính sách local; không nhập nguyên khối recovery upstream |

`flowVideoGen.js`, `flowUpload.js`, `flowBoq.js`, `flowRpcRegistry.js`, `captchaManager.js`, `profileCookies.js` và `veo3ProxyManager.js` được so sánh trực tiếp và trùng sau chuẩn hóa CRLF/source-map. `videoModelResolver.js` khác ở tên/alias model ảnh, không ở bảng video.

## Hai vấn đề cần ưu tiên nếu triển khai sửa

### 1. Model Lower Priority không đồng nghĩa Lite thường

- `utils/videoModelResolver.js:193` vẫn đưa Lite Lower Priority vào danh sách lựa chọn.
- `services/veo3/flowVideoGen.js:61` giữ nguyên key `...lite_low_priority`; không tự chuyển sang Lite thường.
- Kiểm tra helper trên cả hai app trả `verified: false` cho key Lower Priority và `verified: true` cho Lite thường. Cờ này là danh sách key từng được upstream kiểm chứng, không phải phép kiểm tra quyền tài khoản hiện thời.
- Log ngày 21/10 xác nhận chính Lower Priority bị từ chối cho tài khoản của lượt đó. Không thể suy ra mọi tài khoản đều bị từ chối model này.
- Cách xác minh kế tiếp: cùng tài khoản, cùng prompt, cùng tỉ lệ, thử Lite thường; đối chiếu model thực gửi và lý do lỗi. Việc đổi sang Lite thường có thể dùng credit, vì vậy không tự fallback có tính phí từ lựa chọn 0-credit.

### 2. Bộ phân loại Flow đang gộp lỗi quyền thành CAPTCHA

- `services/veo3/flowImageGen.js:130` gán mọi gRPC 7 / HTTP 403 thành `isRecaptchaFailure: true`.
- Video dùng cùng hàm qua alias `classifyFlowGenError` ở dòng 145.
- Mô phỏng không gọi mạng: truyền `FlowRpcError` có status 7 và message `PUBLIC_ERROR_MODEL_ACCESS_DENIED`; cả hai app trả thông báo "reCAPTCHA bị Google từ chối". Lý do gốc chỉ còn trong `cause`.
- Điều này có thể khiến UI báo CAPTCHA dù nguyên nhân thật là quyền model, và khiến đường retry hướng sai. Đây là điểm yếu chung, không phải khác biệt chỉ có VeoWorkflow.
- Đề xuất adapt: nhận diện reason gốc trước, giữ phân biệt model-access, quota/traffic, signed-out và verification; không biến mọi 403 thành cùng một loại lỗi.

## Quyết định audit

| Hạng mục | Quyết định đề xuất | Phạm vi |
| --- | --- | --- |
| Submit/upload/poll/auth video hiện tại | Ignore copy: đã tương đương | Giữ `Veo3Service`, helper BOQ và video hiện có |
| Quyền model / lựa chọn Lower Priority | Adapt | Model catalog, validate lựa chọn theo tài khoản, thông báo rõ trước khi người dùng đổi model |
| Phân loại lỗi Flow | Adapt | `flowImageGen.js` và các nơi đọc error/cause trong Gen Normal |
| Chống gửi trùng job | Adapt | `genNormalQueueManager.js`; review cả submit batch nhiều job và retry/cancel |
| Upscale/tải trùng | Defer | `genNormal.service.js`, `GenNormalStatusPoller.js`; ngoài nguyên nhân base gen hiện có |
| Workflow graph/batch/custom nodes | Preserve local | Không thay nguyên thư mục workflow |
| DB/schema, UI, IPC không liên quan hợp đồng video | Defer | Chưa có bằng chứng cần đổi schema để giải quyết lỗi này |
| Auth/license/integrity/branding/updater upstream | Ignore by policy | Không áp dụng |
| File upstream bị xóa | Review only | Không xóa file downstream tự động |

Audit hash tổng thể ghi nhận 170 mục: 59 MERGE_REQUIRED, 77 SAFE_TO_SYNC, 20 IGNORE_BY_POLICY, 14 REVIEW_REQUIRED. Đây là so sánh với baseline 1.8.5, không phải kết luận tất cả đều cần sync. Có 5 file bị upstream bỏ, gồm hai asset renderer cũ, `providers/utils/cookieAuth.js`, `flowTelemetryBuffer.js`, `veo3TokenService.js`; không tự xóa hay promote baseline.

## Kiểm tra đã thực hiện và giới hạn

- Đọc source/backend upstream, source local và runtime của shortcut chính.
- Đọc log và truy vấn SQLite ở chế độ read-only; không đọc/xuất cookie, token hoặc prompt cá nhân.
- Chạy lại pure helper với fixture submit/poll: cả hai trả operation/workflow, status SUCCESSFUL và URL giống nhau.
- Chạy mô phỏng phân loại lỗi quyền model trên cả hai bản: cùng bị gán CAPTCHA.
- Không gửi yêu cầu generation tới Google, không dùng credit, không khởi chạy app, không sửa source chức năng, không build/package/push/release.

Để kết luận lỗi đang xảy ra hiện nay cần một lượt lỗi mới của đúng app/model/profile người dùng đang thử. Trước khi đó, nguyên nhân đã chứng minh được chỉ là lỗi model-access của lượt cũ; lỗi gửi trùng và lỗi gán nhãn là các phát hiện mã nguồn có thể tái hiện cục bộ.

## Phần sửa đã áp dụng sau audit

Branch `codex/fix-veo-video-submit` đã adapt hai thay đổi hẹp từ kết quả audit:

- Phân loại gRPC 7 / HTTP 403 theo bằng chứng provider. `PUBLIC_ERROR_MODEL_ACCESS_DENIED` trở thành lỗi terminal có hướng dẫn kiểm tra model/gói; chỉ `PUBLIC_ERROR_UNUSUAL_ACTIVITY` hoặc thông báo reCAPTCHA rõ ràng mới đi vào luồng xác minh. Một lỗi permission không rõ lý do dừng với mã `FLOW_PERMISSION_DENIED`, không tự reset profile.
- Thêm registry cho các job đang submit. Job đầu và mọi job phụ trong batch ảnh/video được claim trước lần `await` đầu tiên, bị bỏ qua khi queue được dựng lại và được giải phóng cùng submit gốc. Guard tự hết hạn sau 5 phút để tránh trạng thái kẹt nếu callback không hoàn tất.

Không tự chuyển từ Lower Priority sang Lite thường vì thay đổi đó có thể sử dụng credit. Người dùng vẫn chủ động chọn model phù hợp với quyền của tài khoản.

Kiểm tra tĩnh/mocked: 23/23 test tập trung qua, typecheck server/renderer qua và build source server/renderer qua. Bộ architecture toàn repo qua 274/275; test duy nhất hỏng là preset `girlsPrincessDressWorkflow` đã có thay đổi ngoài phạm vi video. Chưa chạy generation thật nên chưa xác nhận bằng credit/API Google.
