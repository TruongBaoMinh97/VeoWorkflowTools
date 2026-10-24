// Bootstrap file - Setup module resolution BEFORE any imports
// This must be the entry point for packaged app
import path from 'path';
import { fileURLToPath } from 'url';
// ES module equivalents for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
console.log('[Bootstrap] Module resolution configured');
console.log('[Bootstrap] Server path:', __dirname);
// Now load the actual server
import('./index.js').catch(err => {
    console.error('[Bootstrap] Failed to load server:', err);
    process.exit(1);
});
