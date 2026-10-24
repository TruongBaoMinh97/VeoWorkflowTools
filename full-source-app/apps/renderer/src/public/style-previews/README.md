# Style previews

Ảnh/video preview cho các style trong StyleGridPicker (hiện dùng ở Doodle Video).

- Khai báo trong `src/pages/prompts/doodle-video/constants.ts` → `STYLE_PREVIEW_ASSETS`
  (key = `StyleOption.value`, đường dẫn tương đối `./style-previews/<file>`).
- Ảnh: JPEG/WebP ~640px, < 100KB. Video hover: WebM VP9, ≤ 6s, 480px, muted, < 1MB.
- Style không có asset ở đây sẽ tự fallback về emoji — không cần khai đủ.
- Nguồn `vox-collage.*`: repo MIT https://github.com/dongochoan97/vox-director
  (thumbs/football.jpg + showcase-football.mp4 nén lại bằng ffmpeg VP9 crf38, 6s, 480px).
