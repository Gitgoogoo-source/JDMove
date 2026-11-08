// 在 Node 里加载商品页采集脚本（src/inject/jd-price.js、jd-detail.js、jd-item-extract.js），页面是假的：
// 京东新版商品页是 React，商品数据挂在组件状态里（useRef 的 current），脚本遍历 fiber 树找它
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const FILES = ['jd-price.js', 'jd-detail.js', 'jd-item-extract.js'].map((f) =>
  readFileSync(new URL(`../../src/inject/${f}`, import.meta.url), 'utf8'),
);

/** 一个组件：状态链表里只有一个 useRef，current 指向 value */
export const fiber = (value, { child = null, sibling = null } = {}) => ({
  memoizedState: { memoizedState: { current: value }, next: null },
  child,
  sibling,
});

/**
 * 加载采集脚本的假商品页，返回页面里的 window.__JDMOVE__
 * @param {{url?: string, tree?: object|null}} page url：商品页地址（决定域名）；tree：React 根 fiber
 */
export function loadItemPage({ url = 'https://item.jd.com/100200187696.html', tree = null } = {}) {
  const u = new URL(url);
  const root = tree ? { __reactContainer$test: tree } : {};
  const document = {
    title: '商品-京东',
    getElementById: (id) => (id === 'root' ? root : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: { scrollHeight: 0 },
  };
  const ctx = {
    document,
    location: { hostname: u.hostname, href: u.href, pathname: u.pathname },
    innerHeight: 800,
    scrollTo: () => {},
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: async () => ({ ok: false }),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const src of FILES) vm.runInContext(src, ctx);
  return ctx.__JDMOVE__;
}

/** 页面脚本的返回值来自另一个 vm 上下文：转成本上下文的普通对象，便于 deepEqual */
export const plain = (o) => JSON.parse(JSON.stringify(o));
