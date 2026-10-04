// Static checks for every root-level .html. Exits non-zero on any failure.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GMAIL_CLIP = 102 * 1024;
let failed = 0;

for (const file of readdirSync(root).filter((f) => f.endsWith('.html') && !f.startsWith('.')).sort()) {
  const raw = readFileSync(path.join(root, file), 'utf8');
  // Drop plain comments (keep MSO conditionals) so prose in comments isn't parsed as markup.
  const html = raw.replace(/<!--(?!>)(?!\[if)(?!<!\[endif)(?!\s*<!\[endif)[\s\S]*?-->/g, '');
  const body = html.slice(html.indexOf('<body'));
  const errors = [];
  const count = (re) => (html.match(re) || []).length;

  const bytes = Buffer.byteLength(raw);
  if (bytes >= GMAIL_CLIP) errors.push(`${(bytes / 1024).toFixed(1)} KB, Gmail clips at 102 KB`);
  if (!/<html[^>]+lang="[a-z-]+"/i.test(html)) errors.push('<html> missing lang');
  if (!/<title>[^<]+<\/title>/.test(html)) errors.push('missing <title>');
  if (/<link[^>]+stylesheet/i.test(html) || /@import/i.test(html)) errors.push('external CSS');
  if (/<script/i.test(html)) errors.push('<script> present');
  if (!/<o:PixelsPerInch>96<\/o:PixelsPerInch>/.test(html)) errors.push('missing OfficeDocumentSettings PixelsPerInch');
  if (!/name="color-scheme"/.test(html) || !/name="supported-color-schemes"/.test(html)) errors.push('missing color-scheme meta');

  for (const tag of ['table', 'tr', 'td', 'a', 'p', 'div']) {
    const open = count(new RegExp(`<${tag}[\\s>]`, 'g'));
    const close = count(new RegExp(`</${tag}>`, 'g'));
    if (open !== close) errors.push(`<${tag}> ${open} open / ${close} close`);
  }
  const ifs = count(/<!--\[if /g);
  const endifs = count(/<!\[endif\]-->/g);
  if (ifs !== endifs) errors.push(`conditional comments: ${ifs} [if / ${endifs} [endif]`);

  for (const t of body.match(/<table\b[^>]*>/g) || []) {
    if (!/role="presentation"/.test(t) && !/class="[^"]*data-table/.test(t)) errors.push(`layout table without role="presentation": ${t.slice(0, 70)}`);
  }
  // Divs are allowed only as the article wrapper, the preheader, and hybrid column wrappers.
  for (const d of body.match(/<div\b[^>]*>/g) || []) {
    const ok = /role="article"/.test(d) || /display:none/.test(d) || /class="[a-z]+-col"[^>]*display:inline-block/.test(d);
    if (!ok) errors.push(`structural <div>: ${d.slice(0, 70)}`);
  }
  for (const img of body.match(/<img\b[^>]*>/g) || []) {
    const src = (img.match(/src="([^"]+)"/) || [])[1];
    if (!/\salt="[^"]*"/.test(img)) errors.push(`img without alt: ${src}`);
    if (!/\swidth="\d+"/.test(img)) errors.push(`img without width: ${src}`);
    if (!/\sborder="0"/.test(img)) errors.push(`img without border="0": ${src}`);
    if (!/display:block/.test(img)) errors.push(`img without display:block: ${src}`);
    if (src && !/^https?:/.test(src) && !existsSync(path.join(root, src))) errors.push(`missing image file: ${src}`);
  }
  for (const a of body.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) || []) {
    const text = a.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim().toLowerCase();
    if (['click here', 'here', 'read more', 'learn more', 'more'].includes(text)) errors.push(`vague link text: "${text}"`);
    if (!/<img/.test(a) && !text) errors.push('empty link');
  }
  // Text elements carry inline styles; cells with only sizing attributes (ghost cells) are structural.
  for (const el of body.match(/<(td|p|a|h[1-3]|span)\b[^>]*>/g) || []) {
    if (!/style="/.test(el) && !/^<td(\s+(width|height|valign|align)="[^"]*")*>$/.test(el)) errors.push(`no inline style: ${el.slice(0, 60)}`);
  }

  console.log(`${errors.length ? 'FAIL' : 'ok  '}  ${file}  ${(bytes / 1024).toFixed(1)} KB`);
  for (const e of errors) console.log(`      ${e}`);
  failed += errors.length;
}
process.exit(failed ? 1 : 0);
