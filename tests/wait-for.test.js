// 页面桥接脚本（src/inject/backend-core.js）的 waitFor：后台标签页的定时器会被限流
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CORE_SRC = readFileSync(new URL('../src/inject/backend-core.js', import.meta.url), 'utf8');

/** 定时器按后台标签页限流：每个 setTimeout 至少 1 秒（用虚拟时钟，测试不真的等待） */
function loadThrottledPage() {
  let clock = 0;
  const window = { __JDMOVE__: {} };
  vm.runInNewContext(CORE_SRC, {
    window,
    document: { querySelector: () => null, querySelectorAll: () => [] },
    location: { href: 'https://wares-jdm.jd.com/vcProductPublish/', pathname: '/vcProductPublish/' },
    Date: { now: () => clock },
    setTimeout: (fn, ms) => {
      clock += Math.max(ms ?? 0, 1000);
      setImmediate(fn);
    },
    clearTimeout: () => {},
  });
  return window.__JDMOVE__.backend;
}

test('waitFor: 定时器被限流、一次 sleep 就越过时限时，超时前最后再检查一次', async () => {
  const B = loadThrottledPage();
  let ready = false;
  queueMicrotask(() => {
    ready = true;
  });
  assert.equal(await B.util.waitFor(() => ready, { timeout: 800, interval: 200 }), true);
  assert.equal(await B.util.waitFor(() => false, { timeout: 800 }), null);
});
