import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(__dirname, '..');
const srcDir = path.join(rendererRoot, 'src');

const requiredFiles = [
  'core/app-shell.js',
  'core/app-shell.css',
  'pages/GenNormalDetailPage.js',
  'features/manga-story/MangaStoryPanel.js',
  'features/story-workflow/MultiStoryPanel.js',
  'features/story-workflow/StoryCapcutSync.js',
  'features/story-workflow/InlineStoryPrompts.js',
  'features/prompt-rewrite/PolicyPromptRewrite.js',
  'styles/manga-story.css',
];

for (const rel of requiredFiles) {
  const fullPath = path.join(srcDir, rel);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`[renderer:typecheck] Missing source file: ${rel}`);
  }
  if (rel.endsWith('.js')) {
    execFileSync(process.execPath, ['--check', fullPath], { stdio: 'inherit' });
  }
}

console.log('[renderer:typecheck] All renderer source modules validated successfully.');
