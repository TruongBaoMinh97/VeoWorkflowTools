# Phát triển VeoWorkflowTools từ source

## Nguồn mã chính

- Backend: `full-source-app/apps/server/src`
- Test: `full-source-app/apps/server/tests`
- Prisma schema: `full-source-app/apps/server/prisma/schema.prisma`
- Python helpers: `full-source-app/apps/server/python`
- Captcha extension: `full-source-app/extension/captcha-extension`

`dist`, `server-runtime`, `full-resources`, `dist-releases`, `release` và
`backups` là output hoặc dữ liệu vận hành. Không sửa các thư mục đó để phát
triển tính năng.

## Lệnh phát triển

Chạy tại `D:\VeoWorkflowTools`:

```powershell
npm run typecheck
npm test
npm run dev
```

`npm run dev` build backend từ source bằng script của package server rồi chạy
`dist/index.js` với source maps. Khi chỉ cần tạo output kiểm tra:

```powershell
npm run build
```

Desktop shell hiện tại có thể mở bằng:

```powershell
npm run dev:desktop
```

Renderer và phần lớn Electron hiện chưa có source gốc trong workspace. Chỉ có
bundle `dist` lịch sử, nên không sửa giao diện bằng cách patch bundle. Khôi phục
source React/Vite và Electron TypeScript trước khi tiếp tục phát triển hai phần
này.

## Git và GitHub

Mỗi thay đổi bắt đầu từ một branch:

```powershell
git switch -c codex/ten-thay-doi
```

Chỉ commit source, test và tài liệu. Sau khi các lệnh kiểm tra đạt:

```powershell
git add <cac-file-lien-quan>
git commit -m "Mô tả thay đổi"
git push -u origin HEAD
```

Tạo tag và GitHub Release riêng khi cần phát hành cho máy khác. Việc commit hoặc
push source không tự tạo bộ cài và không sửa app đang cài.
