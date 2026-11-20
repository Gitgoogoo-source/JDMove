// 启动 / 连接装有本插件的调试浏览器，并在插件环境里执行代码
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ARTIFACT_DIR, CDP_PORT, CDP_URL, EXT_DIR, EXT_ID, PROFILE_DIR, extUrl, resolveChromeBinary } from './config.mjs';

const LAUNCH_TIMEOUT_MS = 20000;
const SW_TIMEOUT_MS = 10000;
const EVAL_TIMEOUT_MS = 60000;
// 用来执行代码的插件页：manifest.json 也是插件源的页面，有完整 chrome.* 权限，且没有业务脚本
const EVAL_PAGE_PATH = 'manifest.json';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function isRunning() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntil(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`等待超时：${what}`);
}

function chromeArgs({ headless }) {
  return [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ];
}

// 浏览器作为独立进程常驻，脚本退出后不关闭，登录状态保存在 PROFILE_DIR
export async function launch({ headless = process.env.E2E_HEADLESS === '1' } = {}) {
  let started = null;
  if (!(await isRunning())) {
    const binary = await resolveChromeBinary();
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const log = openSync(join(ARTIFACT_DIR, 'chrome.log'), 'a');
    const child = spawn(binary, chromeArgs({ headless }), { detached: true, stdio: ['ignore', log, log] });
    child.unref();
    await waitUntil(isRunning, LAUNCH_TIMEOUT_MS, `浏览器调试端口 ${CDP_PORT}`);
    started = { pid: child.pid, binary };
  }
  const { browser, context } = await connect();
  try {
    return { started, extension: await prepareProfile(context) };
  } finally {
    await browser.close();
  }
}

export async function connect() {
  if (!(await isRunning())) throw new Error(`调试浏览器没有运行（端口 ${CDP_PORT}），先执行：npm run e2e -- launch`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  if (!context) throw new Error('连接成功但没有默认浏览器上下文');
  return { browser, context };
}

export const findPage = (context, predicate) => context.pages().find((p) => predicate(p.url()));

export async function openPage(context, url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

async function evalPage(context) {
  const existing = findPage(context, (u) => u === extUrl(EVAL_PAGE_PATH));
  return existing ?? openPage(context, extUrl(EVAL_PAGE_PATH));
}

// 把一段 async 函数体放进插件页执行：可用 chrome.*，可 `await import('/src/lib/xxx.js')`，return 的值必须可 JSON 序列化
export async function evalInExtension(context, body, arg) {
  const page = await evalPage(context);
  return page.evaluate(
    async ({ body, arg }) => {
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      return new AsyncFunction('arg', body)(arg);
    },
    { body, arg },
  );
}

async function findServiceWorkerTarget() {
  const res = await fetch(`${CDP_URL}/json/list`, { signal: AbortSignal.timeout(2000) });
  const targets = await res.json();
  return targets.find((t) => t.type === 'service_worker' && t.url.startsWith(extUrl()));
}

// MV3 后台闲置会休眠：没找到时从插件页发一条消息把它唤醒
async function serviceWorkerTarget(context) {
  let target = await findServiceWorkerTarget();
  if (target) return target;
  await evalInExtension(context, "return chrome.runtime.sendMessage({ type: 'sleep', ms: 0 });").catch(() => {});
  await waitUntil(async () => (target = await findServiceWorkerTarget()), SW_TIMEOUT_MS, '插件后台 service worker');
  return target;
}

function cdpCall(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`${method} 超时`));
    }, EVAL_TIMEOUT_MS);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`连接 service worker 失败：${wsUrl}`));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    };
  });
}

// 在后台 service worker 里执行（SW 里不能用 import()，只能访问全局和 chrome.*）
export async function evalInServiceWorker(context, body, arg) {
  const target = await serviceWorkerTarget(context);
  const expression = `(async (arg) => { ${body}\n })(${JSON.stringify(arg ?? null)})`;
  const { result, exceptionDetails } = await cdpCall(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

// manifest 里 content_scripts 注入的页面：插件重载后这些页里的旧脚本失效，需要刷新
const CONTENT_SCRIPT_PAGES = /^https:\/\/(item\.jd\.com|npcitem\.jd\.hk|item\.jingdonghealth\.cn|b2b\.jd\.com\/goods\/goods-detail)\//;

// 改完代码后重载插件，并刷新商品页（VC 发布页等不刷新，以免丢掉填了一半的表单）
export async function reloadExtension(context) {
  const before = context.pages().map((p) => p.url());
  await evalInExtension(context, 'setTimeout(() => chrome.runtime.reload(), 50); return true;');
  await delay(1000);
  await serviceWorkerTarget(context);
  const reloaded = [];
  for (const page of context.pages()) {
    const url = page.url();
    if (CONTENT_SCRIPT_PAGES.test(url)) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      reloaded.push(url);
    }
  }
  return { closedExtensionPages: before.filter((u) => u.startsWith(extUrl())), reloaded };
}

async function onExtensionsPage(context, fn, arg) {
  const page = await openPage(context, 'chrome://extensions/');
  try {
    return await page.evaluate(fn, arg);
  } finally {
    await page.close();
  }
}

// 开发者模式必须打开：否则命令行加载的插件一重载就被禁用（unsupportedDeveloperExtension）
// 插件被禁用时重新启用
export function prepareProfile(context) {
  return onExtensionsPage(
    context,
    async (id) => {
      const dp = chrome.developerPrivate;
      await dp.updateProfileConfiguration({ inDeveloperMode: true });
      let info = await dp.getExtensionInfo(id);
      // 切换开发者模式可能让插件重载一次，等它恢复；仍是禁用状态才手动启用
      const settle = async () => {
        for (let i = 0; i < 20; i += 1) {
          info = await dp.getExtensionInfo(id);
          if (!info.disableReasons?.reloading) return;
          await new Promise((r) => setTimeout(r, 250));
        }
      };
      await settle();
      if (info.state !== 'ENABLED') {
        await chrome.management.setEnabled(id, true);
        await settle();
      }
      const disableReasons = Object.entries(info.disableReasons ?? {}).filter(([, v]) => v).map(([k]) => k);
      return { id, state: info.state, disableReasons, version: info.version };
    },
    EXT_ID,
  );
}

// 插件在 chrome://extensions 里记录的运行错误（含后台和页面里的报错）
export function extensionErrors(context, { clear = false } = {}) {
  return onExtensionsPage(
    context,
    async ({ id, clear }) => {
      const info = await chrome.developerPrivate.getExtensionInfo(id);
      const pick = (e) => ({ message: e.message, source: e.source, context: e.contextUrl, line: e.lineNumber, occurrences: e.occurrences });
      const errors = [...(info.runtimeErrors ?? []).map(pick), ...(info.manifestErrors ?? []).map(pick)];
      if (clear && errors.length) await chrome.developerPrivate.deleteExtensionErrors({ extensionId: id });
      return errors;
    },
    { id: EXT_ID, clear },
  );
}

export async function closeBrowser() {
  if (!(await isRunning())) return false;
  const { browser } = await connect();
  const session = await browser.newBrowserCDPSession();
  await session.send('Browser.close').catch(() => {});
  await waitUntil(async () => !(await isRunning()), LAUNCH_TIMEOUT_MS, '浏览器退出');
  return true;
}

export { EXT_ID };
