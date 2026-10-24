# UpProject Captcha Bridge

Chrome Extension (MV3) — mints Google reCAPTCHA Enterprise tokens trên trang
`flow.google.com` (hoặc `labs.google/fx/tools/flow`) cho backend UpProject chạy cục bộ.

---

## Cài đặt (4 bước)

### Bước 1 — Load extension vào Chrome

1. Mở `chrome://extensions` trên trình duyệt Chrome.
2. Bật **Developer mode** (góc trên phải).
3. Nhấn **Load unpacked** và chọn thư mục `extension/captcha-extension/` này.
4. Extension sẽ xuất hiện với tên **"UpProject Captcha Bridge"**.

> Đây là extension dùng nội bộ, không publish lên Chrome Web Store.
> Load unpacked là cách dùng chính thức trong môi trường phát triển.

---

### Bước 2 — Mở tab Flow AI và đăng nhập Google

1. Nhấn nút **🎬 Mở Flow AI** trong popup của extension (hoặc truy cập
   thủ công: `https://flow.google.com` hoặc `https://labs.google/fx/tools/flow`).
2. Đăng nhập bằng **tài khoản Google master** — tài khoản này sẽ mint
   captcha token cho toàn bộ profile của app.
3. Giữ tab này **luôn mở** trong khi app đang chạy. Đóng tab hoặc để Chrome
   sleep sẽ làm gián đoạn mint.

---

### Bước 3 — Lấy thông tin kết nối từ app và paste vào Options

1. Mở app UpProject → **Settings** → copy **Bridge URL** và **Bridge Secret**.
2. Click icon extension trên thanh Chrome → nhấn **⚙️ Cài đặt**.
3. Paste **Bridge URL** (thường là `http://127.0.0.1:4000`) và **Bridge Secret**
   vào hai ô tương ứng.
4. Nhấn **Lưu cấu hình**.
5. Nhấn **Test kết nối** để xác nhận backend phản hồi đúng.
   - `OK — pending: 0, queued: 0` → bình thường (chưa có job).
   - `HTTP 401` → sai Secret.
   - `Không thể kết nối` → backend chưa khởi động hoặc sai URL.

---

### Bước 4 — Verify badge xanh trong app

1. Trong app UpProject → **Settings** → mục **Captcha Bridge Status**.
2. Badge nên hiển thị `🟢 Extension connected`.
3. Nếu badge là `🔴` hoặc `🟡`:
   - Kiểm tra tab Flow AI còn mở không.
   - Kiểm tra extension chưa bị Chrome tắt (`chrome://extensions`).
   - Kiểm tra Secret khớp với giá trị trong file `userData/captcha-bridge.secret`.

---

## Cơ chế hoạt động

```
Backend (Node.js)
  ↓  GET /api/internal/captcha/poll  (long-poll 25s)
background.js  ←────────────────────────────────────
  ↓  chrome.tabs.sendMessage → GET_CAPTCHA
content.js (ISOLATED world, labs.google / flow.google.com)
  ↓  CustomEvent UPPROJECT_GET_CAPTCHA
injected.js (MAIN world, same context as Flow React app)
  ↓  grecaptcha.enterprise.execute(SITE_KEY, { action })
  ↓  CustomEvent UPPROJECT_CAPTCHA_RESULT
content.js → background.js
  ↓  POST /api/internal/captcha/result  { commandId, token }
Backend  ←───────────────────────────────────────────
```

Extension **không** lưu hay forward cookies. JWT authentication được
backend xử lý độc lập qua `tlsFetch`.

---

## Xử lý sự cố

| Triệu chứng | Nguyên nhân | Cách sửa |
|---|---|---|
| Badge `!` đỏ trên icon extension | Chưa nhập config | Mở Options → nhập URL + Secret |
| `NO_FLOW_TAB` trong backend log | Tab Flow AI bị đóng | Mở lại `flow.google.com` (hoặc `labs.google/fx/tools/flow`) |
| `grecaptcha not available` | Trang chưa load xong | Refresh tab Flow AI |
| `HTTP 401` trong backend log | Bridge Secret sai | Kiểm tra lại Secret trong Options |
| `CONTENT_TIMEOUT` liên tục | Extension bị Chrome sleep | Tắt Power Saver mode; giữ Chrome foreground |
| Popup hiển thị `🟡 Kết nối chậm` | Backend đang khởi động lại | Chờ 30s; nếu vẫn vậy thì restart app |

---

## Files

```
captcha-extension/
├── manifest.json       MV3 manifest
├── background.js       Service worker — poll loop, command dispatch
├── content.js          ISOLATED world bridge (labs.google / flow.google.com)
├── injected.js         MAIN world — chạy grecaptcha.enterprise.execute
├── options.html        Trang cài đặt
├── options.js          Logic trang cài đặt
├── popup.html          Popup nhỏ (click icon extension)
├── popup.js            Logic popup
└── README.md           File này
```
