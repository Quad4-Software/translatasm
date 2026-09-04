#!/usr/bin/env node
/**
 * Capture reusable UI screenshots for docs and README.
 *
 * Usage:
 *   node scripts/screenshot.mjs
 *   node scripts/screenshot.mjs --url https://translatasm.quad4.io
 *   node scripts/screenshot.mjs --local
 *   node scripts/screenshot.mjs --out docs/screenshots --only desktop
 *   SCREENSHOT_URL=http://127.0.0.1:8080 node scripts/screenshot.mjs
 *
 * Needs the playwright package on NODE_PATH (see make screenshots) and a Chromium binary.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const webRoot = path.join(root, 'web');
const require = createRequire(import.meta.url);

const DEFAULT_URL = 'https://translatasm.quad4.io';
const DEFAULT_OUT = path.join(root, 'docs', 'screenshots');

const DEMO = {
  from: 'en',
  to: 'es',
  source:
    'Offline neural machine translation in your browser. Text stays on device. Nothing is uploaded.',
  target:
    'Traducción automática neuronal sin conexión en tu navegador. El texto permanece en el dispositivo. No se sube nada.',
  status: 'Ready (WASM). Type to translate.',
  latency: '42 ms',
};

/** @type {Array<{name: string, viewport: {width: number, height: number}, deviceScaleFactor?: number, isMobile?: boolean, fullPage?: boolean, dict?: boolean, showTargetTab?: boolean}>} */
const SHOTS = [
  {
    name: 'desktop',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    fullPage: false,
  },
  {
    name: 'mobile',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    fullPage: false,
    showTargetTab: true,
  },
  {
    name: 'dict',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    dict: true,
  },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{url: string | null, out: string, only: string | null, local: boolean, seed: boolean, help: boolean}} */
  const opts = {
    url: process.env.SCREENSHOT_URL || null,
    out: process.env.SCREENSHOT_OUT || DEFAULT_OUT,
    only: process.env.SCREENSHOT_ONLY || null,
    local: false,
    seed: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--local') {
      opts.local = true;
    } else if (a === '--no-seed') {
      opts.seed = false;
    } else if (a === '--url' && argv[i + 1]) {
      opts.url = argv[++i];
    } else if (a === '--out' && argv[i + 1]) {
      opts.out = path.resolve(argv[++i]);
    } else if (a === '--only' && argv[i + 1]) {
      opts.only = argv[++i];
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Capture translatasm UI screenshots.

Usage:
  node scripts/screenshot.mjs [options]

Options:
  --url <url>     Page to capture (default: ${DEFAULT_URL} or SCREENSHOT_URL)
  --local         Serve ./web on an ephemeral port instead of a remote URL
  --out <dir>     Output directory (default: docs/screenshots)
  --only <name>   Capture one shot: desktop | mobile | dict
  --no-seed       Do not inject demo source/target text
  -h, --help      Show this help

Examples:
  make screenshots
  node scripts/screenshot.mjs --local --only desktop
  SCREENSHOT_URL=http://127.0.0.1:8080 node scripts/screenshot.mjs
`);
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @returns {typeof import('playwright')}
 */
function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error(
      'playwright is required. Run: make screenshots',
    );
  }
}

/**
 * @returns {string | undefined}
 */
function findChrome() {
  const fromEnv = process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  const which = spawnSync('which', ['chromium', 'chromium-browser', 'google-chrome'], {
    encoding: 'utf8',
  });
  if (which.status === 0) {
    const line = which.stdout.trim().split('\n')[0];
    if (line) {
      return line;
    }
  }
  return undefined;
}

/**
 * @param {string} dir
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
function serveStatic(dir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const raw = decodeURIComponent((req.url || '/').split('?')[0]);
        let rel = raw === '/' ? '/index.html' : raw;
        if (rel.includes('\0') || rel.includes('..')) {
          res.writeHead(400);
          res.end('bad path');
          return;
        }
        const filePath = path.join(dir, rel);
        if (!filePath.startsWith(dir)) {
          res.writeHead(403);
          res.end('forbidden');
          return;
        }
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
      } catch {
        res.writeHead(500);
        res.end('internal error');
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to bind screenshot server'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

/**
 * @param {import('playwright').Page} page
 * @param {{seed: boolean, dict: boolean, showTargetTab?: boolean}} opts
 */
async function preparePage(page, opts) {
  await page.waitForSelector('#source', { timeout: 30_000 });
  await page.waitForSelector('#status', { timeout: 30_000 });

  try {
    await page.waitForFunction(
      () => {
        const el = document.getElementById('status');
        const t = (el && el.textContent) || '';
        return /ready/i.test(t) || /type to translate/i.test(t);
      },
      { timeout: 45_000 },
    );
  } catch {
    // Local static without models often never reaches Ready. Seed still works.
  }

  if (opts.seed) {
    await page.evaluate((demo) => {
      const from = /** @type {HTMLSelectElement | null} */ (document.getElementById('from'));
      const to = /** @type {HTMLSelectElement | null} */ (document.getElementById('to'));
      const source = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('source'));
      const target = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('target'));
      const status = document.getElementById('status');
      const latency = document.getElementById('latency');
      const sourceCount = document.getElementById('source-count');
      const btnCopy = /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-copy'));
      const btnClear = /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-clear'));
      const btnDownload = /** @type {HTMLButtonElement | null} */ (
        document.getElementById('btn-download')
      );
      const err = document.getElementById('error');
      const spinner = document.getElementById('spinner');
      const progressTrack = document.querySelector('.progress-track');

      if (from && [...from.options].some((o) => o.value === demo.from)) {
        from.value = demo.from;
      }
      if (to && [...to.options].some((o) => o.value === demo.to)) {
        to.value = demo.to;
      }
      if (source) {
        source.value = demo.source;
      }
      if (target) {
        target.value = demo.target;
      }
      if (status) {
        status.textContent = demo.status;
      }
      if (latency) {
        latency.textContent = demo.latency;
      }
      if (sourceCount) {
        sourceCount.textContent = String(demo.source.length);
      }
      if (btnCopy) {
        btnCopy.disabled = false;
      }
      if (btnClear) {
        btnClear.disabled = false;
      }
      if (btnDownload) {
        btnDownload.disabled = false;
      }
      if (err) {
        err.hidden = true;
      }
      if (spinner) {
        spinner.hidden = true;
      }
      if (progressTrack) {
        progressTrack.hidden = true;
      }
    }, DEMO);

    if (opts.showTargetTab) {
      const tab = page.locator('#tab-target');
      if (await tab.count()) {
        await tab.click().catch(() => {});
      }
    }
  }

  if (opts.dict) {
    const btn = page.locator('#btn-dict');
    if (await btn.count()) {
      await btn.click();
      await page.waitForSelector('#dict-panel[aria-hidden="false"], .dict-panel:not([aria-hidden="true"])', {
        timeout: 5_000,
      }).catch(() => {});
      const input = page.locator('#dict-input, [data-dict-input]');
      if (await input.count()) {
        await input.fill('hello');
        await page.locator('[data-dict-form] button[type="submit"], .dict-form button[type="submit"]').click().catch(() => {});
        await sleep(600);
      }
    }
  }

  await sleep(250);
}

/**
 * @param {import('playwright').Browser} browser
 * @param {string} baseUrl
 * @param {(typeof SHOTS)[number]} shot
 * @param {{outDir: string, seed: boolean}} opts
 */
async function captureShot(browser, baseUrl, shot, opts) {
  const context = await browser.newContext({
    viewport: shot.viewport,
    deviceScaleFactor: shot.deviceScaleFactor ?? 1,
    isMobile: Boolean(shot.isMobile),
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 60_000 });
  await preparePage(page, {
    seed: opts.seed,
    dict: Boolean(shot.dict),
    showTargetTab: Boolean(shot.showTargetTab),
  });

  const file = path.join(opts.outDir, `${shot.name}.png`);
  await page.screenshot({
    path: file,
    fullPage: Boolean(shot.fullPage),
    type: 'png',
  });
  await context.close();
  return file;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const playwright = loadPlaywright();
  const chromePath = findChrome();

  let closer = async () => {};
  let baseUrl = opts.url || DEFAULT_URL;

  if (opts.local || process.env.SCREENSHOT_LOCAL === '1') {
    const served = await serveStatic(webRoot);
    baseUrl = served.url;
    closer = served.close;
    console.log(`serving ${webRoot} at ${baseUrl}`);
  } else {
    console.log(`capturing ${baseUrl}`);
  }

  fs.mkdirSync(opts.out, { recursive: true });

  /** @type {import('playwright').LaunchOptions} */
  const launchOpts = {
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  };
  if (chromePath) {
    launchOpts.executablePath = chromePath;
    console.log(`using chrome: ${chromePath}`);
  }

  const browser = await playwright.chromium.launch(launchOpts);
  const want = opts.only ? SHOTS.filter((s) => s.name === opts.only) : SHOTS;
  if (!want.length) {
    throw new Error(`no shots matched --only ${opts.only}`);
  }

  try {
    for (const shot of want) {
      const file = await captureShot(browser, baseUrl, shot, {
        outDir: opts.out,
        seed: opts.seed,
      });
      const st = fs.statSync(file);
      console.log(`wrote ${path.relative(root, file)} (${st.size} bytes)`);
    }
  } finally {
    await browser.close();
    await closer();
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
