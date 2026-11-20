// E2E 调试浏览器的固定配置：插件目录、专用用户目录、调试端口
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const EXT_DIR = ROOT;
export const PROFILE_DIR = process.env.E2E_PROFILE ? resolve(process.env.E2E_PROFILE) : join(ROOT, '.e2e-profile');
export const ARTIFACT_DIR = join(ROOT, '.e2e-artifacts');
export const CDP_PORT = Number(process.env.E2E_CDP_PORT) || 9333;
export const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

// 未打包插件的 ID 由目录绝对路径决定：sha256 前 32 个十六进制字符映射到 a-p
export function extensionIdForPath(dir) {
  const hex = createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export const EXT_ID = extensionIdForPath(EXT_DIR);
export const extUrl = (path = '') => `chrome-extension://${EXT_ID}/${path.replace(/^\//, '')}`;

const PLAYWRIGHT_CACHE = join(homedir(), 'Library/Caches/ms-playwright');
const CFT_BINARY = 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const CFT_BINARY_X64 = 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

function newestCachedChromium() {
  if (!existsSync(PLAYWRIGHT_CACHE)) return null;
  const dirs = readdirSync(PLAYWRIGHT_CACHE)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    for (const rel of [CFT_BINARY, CFT_BINARY_X64]) {
      const p = join(PLAYWRIGHT_CACHE, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

// 正式版 Google Chrome 137+ 不再支持 --load-extension，只能用 Chromium / Chrome for Testing
export async function resolveChromeBinary() {
  if (process.env.E2E_CHROME) {
    if (!existsSync(process.env.E2E_CHROME)) throw new Error(`E2E_CHROME 指向的文件不存在：${process.env.E2E_CHROME}`);
    return process.env.E2E_CHROME;
  }
  const { chromium } = await import('playwright-core');
  const bundled = chromium.executablePath();
  if (bundled && existsSync(bundled)) return bundled;
  const cached = newestCachedChromium();
  if (cached) return cached;
  throw new Error('找不到 Chromium：请运行 `npx playwright-core install chromium`，或用 E2E_CHROME 指定 Chrome for Testing 路径');
}
