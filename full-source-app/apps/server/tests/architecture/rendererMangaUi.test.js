import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Renderer source-first Manga Story & Gen Veo3 UI', () => {
  it('maintains modular source for MangaStoryPanel with sticky feedback and interactive helpers', async () => {
    const mangaPanelSource = await readFile(
      new URL('../../../renderer/src/features/manga-story/MangaStoryPanel.js', import.meta.url),
      'utf8'
    );
    const mangaCssSource = await readFile(
      new URL('../../../renderer/src/styles/manga-story.css', import.meta.url),
      'utf8'
    );

    expect(mangaPanelSource).toContain('function MangaStoryPanel');
    expect(mangaPanelSource).toContain('function formatMangaPromptDisplay');
    expect(mangaPanelSource).toContain('manga-modal-top');
    expect(mangaPanelSource).toContain('manga-feedback-zone');
    expect(mangaPanelSource).toContain('manga-nav-tabs');
    expect(mangaPanelSource).toContain('insertTagAtCursor');
    expect(mangaPanelSource).toContain('Lưu & Đóng');
    expect(mangaPanelSource).toContain('Bỏ thay đổi & Đóng');
    expect(mangaPanelSource).toContain('applyPromptPatch');
    expect(mangaPanelSource).toContain('Nhập file sửa cảnh lỗi');
    expect(mangaPanelSource).toContain('Vừa vá lỗi');
    expect(mangaCssSource).toContain('.manga-modal-dialog');
    expect(mangaCssSource).toContain('.manga-btn-primary');
    expect(mangaCssSource).toContain('.manga-char-grid');
  });

  it('includes smart multi-batch merge and in-place CapCut draft patch controls in StoryCapcutSync source', async () => {
    const capcutSyncSource = await readFile(
      new URL('../../../renderer/src/features/story-workflow/StoryCapcutSync.js', import.meta.url),
      'utf8'
    );

    expect(capcutSyncSource).toContain('Gộp thông minh: Lấy ảnh mới nhất mỗi cảnh');
    expect(capcutSyncSource).toContain('/api/workflow/capcut/patch');
    expect(capcutSyncSource).toContain('Cập nhật đè ảnh mới vào project CapCut đã có');
  });

  it('removes blocking credit alert and hardcoded outputDir block in GenNormalDetailPage source', async () => {
    const genPageSource = await readFile(
      new URL('../../../renderer/src/pages/GenNormalDetailPage.js', import.meta.url),
      'utf8'
    );

    expect(genPageSource).not.toContain('V === "D:/NOI CHUA VIDEO/1"');
    expect(genPageSource).not.toContain('f === "D:/NOI CHUA VIDEO/1"');
    expect(genPageSource).not.toContain('Thông tin tài khoản:\nCredit còn lại:');
    expect(genPageSource).toContain('formatMangaPromptDisplay');
    expect(genPageSource).toContain('manga-story-open');
  });
});
