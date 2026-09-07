/* Copies the main site's stylesheet and webfonts into .assets/ before a deploy.
 *
 * The agent pages must look like WeIndie, and WeIndie makes no third-party
 * requests — so the preview serves its own copy rather than hotlinking
 * weindie.com. Nothing is duplicated in Git: .assets/ is generated and ignored,
 * and ../src/site.css stays the single source of truth for the design.
 */
import { mkdirSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..');
const out = join(here, '.assets');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'fonts'), { recursive: true });

copyFileSync(join(site, 'src/site.css'), join(out, 'site.css'));
let n = 0;
for (const f of readdirSync(join(site, 'fonts'))) {
  if (f.endsWith('.woff2')) { copyFileSync(join(site, 'fonts', f), join(out, 'fonts', f)); n++; }
}
console.log(`assets: site.css + ${n} fonts -> .assets/`);
