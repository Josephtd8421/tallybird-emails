// Full-page renders of every root-level .html at 600px and 375px:
//   light   default rendering
//   dark    prefers-color-scheme: dark (Apple Mail style)
//   forced  Chromium force-dark on a copy with the color-scheme opt-in removed,
//           approximating the full inversion Gmail's mobile apps apply
// Headless Chromium over raw CDP, no dependencies. CHROME_PATH overrides the binary.
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'screenshots');
const files = readdirSync(root).filter((f) => f.endsWith('.html') && !f.startsWith('.')).sort();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(outDir, { recursive: true });

async function withBrowser(extraFlags, fn) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(path.join(tmpdir(), 'mailshot-'));
  const chrome = spawn(process.env.CHROME_PATH || 'chromium', [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--hide-scrollbars', '--no-first-run', '--disable-gpu', ...extraFlags, 'about:blank',
  ], { stdio: 'ignore' });
  try {
    let target;
    for (let i = 0; i < 150 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && t.url === 'about:blank');
      } catch { /* not listening yet */ }
      if (!target) await sleep(200);
    }
    if (!target) throw new Error('Chromium did not start (a very long TMPDIR breaks its socket path; try TMPDIR=/tmp)');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let seq = 0;
    const pending = new Map();
    const listeners = [];
    ws.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
      for (const l of listeners.filter((x) => x.method === msg.method)) { listeners.splice(listeners.indexOf(l), 1); l.resolve(msg); }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
    const next = (method) => new Promise((resolve) => listeners.push({ method, resolve }));
    await send('Page.enable');
    await fn({ send, next });
    ws.close();
  } finally {
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function shoot({ send, next }, file, width, scheme) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme === 'dark' ? 'dark' : 'light' }] });
  const loaded = next('Page.loadEventFired');
  await send('Page.navigate', { url: `file://${path.join(root, file)}` });
  await loaded;
  await sleep(250);
  const { cssContentSize } = await send('Page.getLayoutMetrics');
  const height = Math.ceil(cssContentSize.height);
  const { data } = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  const { result } = await send('Runtime.evaluate', { expression: 'document.documentElement.scrollWidth', returnByValue: true });
  const name = `${path.basename(file, '.html').replace(/^\.forced-/, '')}-${width}-${scheme}.png`;
  writeFileSync(path.join(outDir, name), Buffer.from(data, 'base64'));
  console.log(`${name}  ${width}x${height}${result.value > width ? `  OVERFLOW ${result.value}px` : ''}`);
}

await withBrowser([], async (cdp) => {
  for (const file of files) {
    for (const [width, scheme] of [[600, 'light'], [600, 'dark'], [375, 'light'], [375, 'dark']]) {
      await shoot(cdp, file, width, scheme);
    }
  }
});

// Copies sit beside the originals so relative image paths still resolve.
const copies = files.map((file) => {
  const copy = `.forced-${file}`;
  const html = readFileSync(path.join(root, file), 'utf8')
    .replace(/<meta name="(supported-)?color-scheme"[^>]*>/g, '')
    .replace(/color-scheme: light dark;/g, 'color-scheme: light;')
    .replace(/@media \(prefers-color-scheme: dark\)/g, '@media (max-width: 0)');
  writeFileSync(path.join(root, copy), html);
  return copy;
});
try {
  await withBrowser(['--force-dark-mode', '--enable-features=WebContentsForceDark'], async (cdp) => {
    for (const copy of copies) await shoot(cdp, copy, 375, 'forced');
  });
} finally {
  for (const copy of copies) rmSync(path.join(root, copy), { force: true });
}
