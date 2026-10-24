import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(__dirname, '..');
const srcDir = path.join(rendererRoot, 'src');
const distDir = path.join(rendererRoot, 'dist');
const electronRendererDist = path.resolve(rendererRoot, '../electron/dist/renderer');

function copyDirRecursive(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const srcPath = path.join(fromDir, entry.name);
    const dstPath = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

export function buildRenderer() {
  const shellJs = fs.readFileSync(path.join(srcDir, 'core/app-shell.js'), 'utf8');
  const genNormalDetailPageJs = fs.readFileSync(
    path.join(srcDir, 'pages/GenNormalDetailPage.js'),
    'utf8'
  );
  const multiStoryJs = fs.readFileSync(
    path.join(srcDir, 'features/story-workflow/MultiStoryPanel.js'),
    'utf8'
  );
  const mangaStoryJs = fs.readFileSync(
    path.join(srcDir, 'features/manga-story/MangaStoryPanel.js'),
    'utf8'
  );
  const promptRewriteJs = fs.readFileSync(
    path.join(srcDir, 'features/prompt-rewrite/PolicyPromptRewrite.js'),
    'utf8'
  );
  const storyCapcutSyncJs = fs.readFileSync(
    path.join(srcDir, 'features/story-workflow/StoryCapcutSync.js'),
    'utf8'
  );
  const inlineStoryPromptsJs = fs.readFileSync(
    path.join(srcDir, 'features/story-workflow/InlineStoryPrompts.js'),
    'utf8'
  );

  if (!shellJs.includes('/* __GEN_NORMAL_DETAIL_PAGE_MODULE__ */')) {
    throw new Error('Missing __GEN_NORMAL_DETAIL_PAGE_MODULE__ placeholder in app-shell.js');
  }
  if (!shellJs.includes('/* __STORY_FEATURES_MODULES__ */')) {
    throw new Error('Missing __STORY_FEATURES_MODULES__ placeholder in app-shell.js');
  }

  const featureBundle = [
    multiStoryJs.trim(),
    mangaStoryJs.trim(),
    promptRewriteJs.trim(),
    storyCapcutSyncJs.trim(),
    inlineStoryPromptsJs.trim(),
  ].join('\n');

  const compiledJs = shellJs
    .replace('/* __GEN_NORMAL_DETAIL_PAGE_MODULE__ */', () => genNormalDetailPageJs.trim())
    .replace('/* __STORY_FEATURES_MODULES__ */', () => featureBundle);

  const shellCss = fs.readFileSync(path.join(srcDir, 'core/app-shell.css'), 'utf8');
  const mangaStoryCss = fs.readFileSync(path.join(srcDir, 'styles/manga-story.css'), 'utf8');
  const compiledCss = `${shellCss.trim()}\n\n${mangaStoryCss.trim()}\n`;

  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  copyDirRecursive(path.join(srcDir, 'public'), distDir);
  fs.copyFileSync(path.join(rendererRoot, 'index.html'), path.join(distDir, 'index.html'));

  const outJsPath = path.join(distDir, 'assets/index-DhSC5-9k.js');
  const outCssPath = path.join(distDir, 'assets/index-B4IyJRf6.css');

  fs.writeFileSync(outJsPath, compiledJs, 'utf8');
  fs.writeFileSync(outCssPath, compiledCss, 'utf8');

  execFileSync(process.execPath, ['--check', outJsPath], { stdio: 'inherit' });

  if (fs.existsSync(path.dirname(electronRendererDist))) {
    copyDirRecursive(distDir, electronRendererDist);
  }

  console.log('[renderer:build] Built renderer dist from full-source-app/apps/renderer/src.');
}

buildRenderer();
