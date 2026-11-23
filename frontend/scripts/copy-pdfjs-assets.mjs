// pdf.js needs its character maps (CJK and other legacy encodings) and the
// standard font files at runtime, as plain files. Copy them next to the app
// so they are served (and cached by the service worker) from /pdfjs/.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', 'pdfjs-dist');
const to = join(root, 'public', 'pdfjs');

if (!existsSync(from)) {
  console.error('pdfjs-dist is not installed — run npm install first');
  process.exit(1);
}
mkdirSync(to, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts']) cpSync(join(from, dir), join(to, dir), { recursive: true });
console.log('pdf.js assets copied to public/pdfjs');
