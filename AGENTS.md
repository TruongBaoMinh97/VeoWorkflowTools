# Quy trình phát triển source-first

Theo yêu cầu của người dùng, từ bây giờ chỉ sửa mã nguồn trong
`D:/VeoWorkflowTools/full-source-app`. Không sửa trực tiếp JavaScript đã build
trong `dist`, `server-runtime`, `full-resources`, `dist-releases` hoặc file
`app.asar`.

Chạy, kiểm tra và tạo output thông qua các script `npm` ở thư mục gốc:

- `npm run dev`: chạy backend phát triển từ source.
- `npm run dev:desktop`: mở desktop shell hiện có để kiểm tra tích hợp.
- `npm run typecheck`: kiểm tra kiểu dữ liệu backend.
- `npm test`: chạy bộ test kiến trúc.
- `npm run build`: tạo backend `dist` từ source khi cần kiểm tra output.

Không cập nhật app cố định hoặc đóng gói sau mỗi thay đổi. Chỉ chạy quy trình
package/release khi người dùng yêu cầu phát hành hoặc cài bản mới.

Phát triển liên tục trên một dòng source hiện tại; không tự chia thành nhiều
bản, tạo thêm bản sao ứng dụng, thư mục release, shortcut hoặc bộ cài. Chỉ tạo
package, bản cài, bản release hay một biến thể riêng khi người dùng yêu cầu rõ.

Dùng backup ở mức tối thiểu. Chỉ tạo backup khi thao tác có rủi ro thực tế đối
với dữ liệu hoặc khi người dùng yêu cầu; không tạo backup lặp lại cho các thay
đổi source thông thường đã được Git quản lý.

Mọi thay đổi phiên bản được quản lý bằng Git và GitHub:

- Tạo branch `codex/<ten-thay-doi>` cho công việc mới.
- Commit source, test, schema và tài liệu liên quan; không commit output build,
  database, user data, cookie, token, log, backup hoặc bộ cài.
- Push branch/PR lên `origin` để lưu lịch sử và review.
- Chỉ tạo tag/GitHub Release khi người dùng yêu cầu phát hành.

Hiện backend có source đầy đủ tại `full-source-app/apps/server/src`. Renderer
và phần lớn Electron hiện chỉ còn bundle `dist`; không tiếp tục chỉnh bundle
này. Cần khôi phục source React/Vite và Electron TypeScript trước khi phát triển
giao diện hoặc Electron theo quy trình mới.

Giữ nguyên dữ liệu người dùng và các backup hiện có. Không tự xóa chúng.
