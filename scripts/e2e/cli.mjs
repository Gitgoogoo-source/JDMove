#!/usr/bin/env node
// 调试浏览器命令行：npm run e2e -- <命令> [参数]，给 AI / 开发者测试插件用
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as b from './browser.mjs';
import { ARTIFACT_DIR, CDP_URL, EXT_ID, PROFILE_DIR, extUrl } from './config.mjs';

const USAGE = `用法：npm run e2e -- <命令>

  launch [--headless]        启动调试浏览器（已在运行则只检查插件状态）
  status                     浏览器 / 插件 / 后台状态
  reload                     重载插件（改完代码后执行），并刷新已打开的商品页
  eval <代码|@文件>           在插件页执行 async 函数体：可用 chrome.*、await import('/src/lib/x.js')
  sw <代码|@文件>             在后台 service worker 里执行（不能 import）
  page <网址片段> <代码|@文件>  在匹配的标签页主世界执行（读页面 DOM / 变量）
  open <网址|插件内路径>       新开标签页，如 open src/dashboard/dashboard.html
  tabs                       列出标签页
  shot <网址片段> [文件]       截图，默认存到 .e2e-artifacts/
  logs <网址片段> [秒数]       打开/找到标签页后收集控制台输出（默认 10 秒）
  errors [--clear]           插件运行错误（chrome://extensions 里的“错误”）
  stop                       关闭调试浏览器

代码里用 return 返回结果（需可 JSON 序列化）。`;

const print = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function readCode(src) {
  if (!src) throw new Error('缺少代码参数');
  return src.startsWith('@') ? readFileSync(resolve(src.slice(1)), 'utf8') : src;
}

const toUrl = (target) => (/^[a-z-]+:/.test(target) ? target : extUrl(target));

async function withBrowser(fn) {
  const { browser, context } = await b.connect();
  try {
    return await fn(context);
  } finally {
    await browser.close();
  }
}

function requirePage(context, fragment) {
  if (!fragment) throw new Error('缺少网址片段参数');
  const page = b.findPage(context, (u) => u.includes(fragment));
  if (!page) throw new Error(`没有网址包含“${fragment}”的标签页，先用 tabs 查看或 open 打开`);
  return page;
}

async function status() {
  if (!(await b.isRunning())) return { running: false, cdp: CDP_URL, profile: PROFILE_DIR };
  return withBrowser(async (context) => {
    const extension = await b.prepareProfile(context);
    const sw = await b.evalInServiceWorker(context, 'return location.href;').catch((e) => `不可用：${e.message}`);
    return { running: true, cdp: CDP_URL, profile: PROFILE_DIR, extension, serviceWorker: sw, tabs: context.pages().length };
  });
}

async function shot(context, fragment, file) {
  const page = requirePage(context, fragment);
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const out = resolve(file ?? join(ARTIFACT_DIR, `shot-${Date.now()}.png`));
  await page.screenshot({ path: out, fullPage: false });
  return out;
}

async function logs(context, fragment, seconds) {
  const page = b.findPage(context, (u) => u.includes(fragment)) ?? (await b.openPage(context, toUrl(fragment)));
  const lines = [];
  page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => lines.push(`[pageerror] ${e.message}`));
  await new Promise((r) => setTimeout(r, (Number(seconds) || 10) * 1000));
  return { url: page.url(), lines };
}

const commands = {
  launch: async (args) => b.launch({ headless: args.includes('--headless') || undefined }),
  status,
  reload: () => withBrowser(async (context) => ({ ...(await b.reloadExtension(context)), errors: await b.extensionErrors(context) })),
  eval: ([code]) => withBrowser((c) => b.evalInExtension(c, readCode(code))),
  sw: ([code]) => withBrowser((c) => b.evalInServiceWorker(c, readCode(code))),
  page: ([fragment, code]) =>
    withBrowser((c) =>
      requirePage(c, fragment).evaluate(async (body) => {
        const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
        return new AsyncFunction(body)();
      }, readCode(code)),
    ),
  open: ([target]) =>
    withBrowser(async (c) => {
      if (!target) throw new Error('缺少网址参数');
      const page = await b.openPage(c, toUrl(target));
      return { url: page.url(), title: await page.title() };
    }),
  tabs: () => withBrowser(async (c) => Promise.all(c.pages().map(async (p) => ({ url: p.url(), title: await p.title().catch(() => '') })))),
  shot: ([fragment, file]) => withBrowser((c) => shot(c, fragment, file)),
  logs: ([fragment, seconds]) => withBrowser((c) => logs(c, fragment ?? '', seconds)),
  errors: (args) => withBrowser((c) => b.extensionErrors(c, { clear: args.includes('--clear') })),
  stop: async () => ({ closed: await b.closeBrowser() }),
  id: async () => EXT_ID,
};

const [cmd, ...args] = process.argv.slice(2);
const run = commands[cmd];
if (!run) {
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}
try {
  print(await run(args));
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
