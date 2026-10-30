// 注入到商品页（MAIN world），在 jd-item-extract.js / b2b-item-extract.js 之前加载；除 fetchExternalCss 外都是纯函数，也可在 Node 中测试。
// 京东新版商品页的“商品详情”楼层先渲染骨架 .imgtext-ske，骨架进入视口（IntersectionObserver）后
// 才请求 pc_item_getWareGraphic 并渲染 #detail-main。窗口被遮挡/最小化时 Chrome 不渲染页面，
// 观察回调不会触发，骨架会一直留着，详情图就采不到。
// 详情图多为 ssd-module 方块的背景图：背景图写在 #detail-main 内的 <style> 里，或写在
// <div cssurl="//sku-market-gw.jd.com/css/pc/xxx.css"> 指向的外部样式表里（新版页面不会加载它）。
(() => {
  const NS = (globalThis.__JDMOVE__ = globalThis.__JDMOVE__ || {});

  NS.DETAIL_STATE = Object.freeze({
    ok: 'ok',
    empty: 'empty',
    notLoaded: 'not_loaded',
    parseFailed: 'parse_failed',
    pending: 'pending',
  });

  const EMPTY_TEXT = /暂无商品介绍/;
  const FAIL_TEXT = /网络出小差/;

  /**
   * 判断详情区当前的加载状态
   * @param {{imageCount: number, moduleCount?: number, hasSection: boolean, skeleton: boolean, sectionText: string}} s
   *   imageCount 已解析出的详情图数量；moduleCount 详情区里 ssd-module 方块数量；hasSection 是否有“商品详情”楼层；
   *   skeleton 骨架是否还在；sectionText 楼层文字
   * @returns {'ok'|'empty'|'not_loaded'|'parse_failed'|'pending'} pending 表示还需要继续等待
   */
  NS.classifyDetail = function classifyDetail(s) {
    const { ok, empty, notLoaded, parseFailed, pending } = NS.DETAIL_STATE;
    if (s.imageCount > 0) return ok;
    const txt = s.sectionText || '';
    if (EMPTY_TEXT.test(txt)) return empty;
    if (FAIL_TEXT.test(txt)) return notLoaded;
    if (s.skeleton) return pending;
    // 详情已渲染出方块却没解析出图片：背景图所在的样式表没拿到或页面结构变了，不是源商品没有详情
    if (s.moduleCount > 0) return parseFailed;
    if (!s.hasSection) return pending;
    // 楼层已渲染完（骨架已被替换）却没有图片也没有方块：源商品的详情只有文字/视频
    return empty;
  };

  const RULE_RE = /([^{}]+)\{([^}]*)\}/g;
  const BG_URL_RE = /background(?:-image)?\s*:[^;]*?url\(\s*['"]?([^'")]+)['"]?\s*\)/;
  const LAST_CLASS_RE = /\.([\w-]+)\s*$/;

  /**
   * 从 CSS 文本中取出“选择器最后一个 class → 背景图地址”（同一个 class 只取第一条）
   * @param {string} cssText
   * @returns {Record<string, string>}
   */
  NS.cssBackgrounds = function cssBackgrounds(cssText) {
    const out = {};
    for (const m of String(cssText || '').matchAll(RULE_RE)) {
      const url = (m[2].match(BG_URL_RE) || [])[1];
      const cls = (m[1].trim().match(LAST_CLASS_RE) || [])[1];
      if (url && cls && !out[cls]) out[cls] = url;
    }
    return out;
  };

  const CSS_HOST_RE = /(^|\.)(jd\.com|360buyimg\.com)$/;

  /**
   * 详情区引用的外部样式表地址：补全协议、去重，只保留京东域名（详情内容来自商家装修，不请求其他域名）
   * @param {Array<string|null|undefined>} values cssurl 属性 / <link href> 的原始值
   * @returns {string[]}
   */
  NS.externalCssUrls = function externalCssUrls(values) {
    const out = [];
    for (const v of values || []) {
      const raw = String(v || '').trim();
      const full = raw.startsWith('//') ? `https:${raw}` : raw;
      let url;
      try {
        url = new URL(full);
      } catch {
        continue;
      }
      if (url.protocol !== 'https:' || !CSS_HOST_RE.test(url.hostname)) continue;
      if (!out.includes(url.href)) out.push(url.href);
    }
    return out;
  };

  /** 京东图片地址里的 jfs 路径，去掉 .avif/.webp 等派生后缀和参数；没有时返回空串 */
  NS.jfsOf = (u) => (String(u || '').match(/(jfs\/[^?#!]+?)(?:\.(?:avif|webp|dpg))*(?:$|[?#!])/) || [])[1] || '';

  /**
   * 详情区图片：<img> 与 ssd-module 背景图（CSS 中按模块 class 定义，如 .ssd-module-wrap .M1786...）按 DOM 顺序收集
   * @param {ParentNode} root
   * @param {string} [externalCss] 详情区引用的外部样式表内容（见 fetchExternalCss）
   * @returns {string[]}
   */
  NS.detailFromRoot = function detailFromRoot(root, externalCss = '') {
    const urls = [];
    const inlineCss = Array.from(root.querySelectorAll('style'))
      .map((s) => s.textContent || '')
      .join('\n');
    const bgByClass = NS.cssBackgrounds(`${inlineCss}\n${externalCss}`);
    for (const el of root.querySelectorAll('img, [class*="ssd-module"], [style*="background"]')) {
      if (el.tagName === 'IMG') {
        const u = el.getAttribute('data-lazyload') || el.getAttribute('data-src') || el.getAttribute('data-original') || el.getAttribute('src');
        if (u) urls.push(u);
        continue;
      }
      const cls = Array.from(el.classList).find((c) => bgByClass[c]);
      if (cls) urls.push(bgByClass[cls]);
      const inline = (el.getAttribute('style') || '').match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/);
      if (inline) urls.push(inline[1]);
    }
    return urls.filter((u) => /360buyimg\.com|^\/\/|^https?:/.test(u));
  };

  const CSS_FETCH_TIMEOUT_MS = 5000;

  /**
   * 详情区引用的外部样式表（<div cssurl="//sku-market-gw.jd.com/css/pc/xxx.css">）：新版页面不会加载它，
   * 背景图只写在这里。下载失败的样式表跳过，没解析出图片时由 classifyDetail 记为 parse_failed
   * @param {ParentNode} root
   * @returns {Promise<string>}
   */
  NS.fetchExternalCss = async function fetchExternalCss(root) {
    const attrs = (sel, name) => Array.from(root.querySelectorAll(sel)).map((el) => el.getAttribute(name));
    const refs = attrs('[cssurl]', 'cssurl').concat(attrs('link[rel~="stylesheet"][href]', 'href'));
    const texts = await Promise.all(
      NS.externalCssUrls(refs).map(async (url) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), CSS_FETCH_TIMEOUT_MS);
        try {
          const res = await fetch(url, { credentials: 'omit', signal: ctrl.signal });
          return res.ok ? await res.text() : '';
        } catch {
          return '';
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return texts.join('\n');
  };
})();
