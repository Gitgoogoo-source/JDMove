// 注入到京麦后台的 VC 发布页 / 类目选择页（wares-jdm.jd.com，MAIN world）：公共工具、类目搜索、商品属性。
// 发布页是 Vue3 + form-create：通过组件树拿到 fApi 直接读写表单值，fApi 写不了的部分走 DOM 模拟。
(() => {
  const NS = (window.__JDMOVE__ = window.__JDMOVE__ || {});
  if (NS.backend && NS.backend.__core) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const visible = (el) => !!(el && el.isConnected && (el.offsetParent || el.getClientRects().length));
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[\s:：,，()（）\[\]【】*＊/、\-_.]/g, '');

  function check(fn) {
    try {
      return fn() || null;
    } catch {
      return null; // 页面尚未就绪，继续轮询
    }
  }

  // 超时后再检查一次：标签页在后台（窗口被遮挡、最小化）时 Chrome 把定时器限流到至少 1 秒，
  // 一次 sleep 就可能越过时限；不补这一次，点击后页面已经渲染好的结果会被当成“没出现”
  async function waitFor(fn, { timeout = 15000, interval = 200 } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = check(fn);
      if (v) return v;
      await sleep(interval);
    }
    return check(fn);
  }

  function walkComponents(visit) {
    const host = document.querySelector('#app');
    const app = host && host.__vue_app__;
    if (!app) return;
    const seen = new Set();
    const stack = [app._container._vnode];
    while (stack.length) {
      const v = stack.pop();
      if (!v) continue;
      const c = v.component;
      if (c && !seen.has(c)) {
        seen.add(c);
        if (visit(c) === true) return;
        stack.push(c.subTree);
      }
      if (Array.isArray(v.children)) for (const ch of v.children) if (ch && typeof ch === 'object') stack.push(ch);
      if (v.dynamicChildren) stack.push(...v.dynamicChildren);
      if (v.suspense) stack.push(v.suspense.activeBranch);
    }
  }

  function getFApi() {
    if (NS.__fApi && NS.__fApiHost === location.href) return NS.__fApi;
    let api = null;
    walkComponents((c) => {
      if ((c.type.name || c.type.__name) === 'PublishProduct' && c.setupState && c.setupState.fApi) {
        api = c.setupState.fApi;
        return true;
      }
      return false;
    });
    if (api) {
      NS.__fApi = api;
      NS.__fApiHost = location.href;
    }
    return api;
  }

  function pinia() {
    const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
    return app && app.config.globalProperties.$pinia;
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function click(el) {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.click();
  }

  function buttonByText(label, root = document) {
    return qsa('button', root).find((b) => visible(b) && textOf(b) === label) || null;
  }

  function visibleDialogs() {
    return qsa('.jd-dialog, .jd-message-box, .jd-drawer, [role="dialog"]').filter(visible);
  }

  function messages() {
    return qsa('.jd-message, .jd-notification, .jd-message-box__message').filter(visible).map(textOf).filter(Boolean);
  }

  // ---------- 类目搜索（类目选择页，编辑弹窗里“搜索店铺类目”用） ----------
  // 类目搜索下拉框：结果条目，以及下拉层里的“暂无数据”（不看整个页面，页面别处也可能有这四个字）
  const CATEGORY_POPUP_SEL = '.jd-dropdown-menu, .jd-popper, .jd-select-dropdown, [class*="dropdown"], [class*="popper"]';
  function categoryDropdown() {
    const items = qsa('li.jd-dropdown-menu__item').filter(visible).map(textOf).filter((t) => /\[\d+\]/.test(t));
    const empty = !items.length && qsa(CATEGORY_POPUP_SEL).some((el) => visible(el) && /暂无数据/.test(textOf(el)));
    return { items, key: items.length ? items.join('\n') : empty ? '<empty>' : '' };
  }

  const isCategoryInput = (el) => /类目名称/.test(el.placeholder || '');

  // 发布只走“普通发品”，不使用“智能发品”。类目页可能默认停在“智能发品”（没有类目搜索框），这里切到“普通发品”；
  // 页面可能较晚才渲染出标签，放在轮询里调用
  function findCategoryInput() {
    const input = qsa('input').find(isCategoryInput);
    if (input) return input;
    const tab = qsa('.jd-tabs__item').find((el) => visible(el) && /^普通发品/.test(textOf(el)));
    if (tab) click(tab);
    return null;
  }

  /**
   * 输入关键词后，下拉框在接口返回前仍显示上一次的内容：
   * 与上一次相同的内容、“暂无数据”都要在输入后至少 settleMs 且连续两次读取一致才认定
   */
  async function searchCategory(keyword, opts = {}) {
    const { timeout = 8000, settleMs = 1500, interval = 200 } = opts;
    const input = await waitFor(findCategoryInput);
    if (!input) return { ok: false, error: '找不到“普通发品”的类目搜索框', results: [] };
    const stale = categoryDropdown().key;
    setNativeValue(input, '');
    await sleep(Math.min(settleMs, 300));
    await waitFor(() => !categoryDropdown().key, { timeout: Math.min(settleMs, 1000), interval });
    input.focus();
    setNativeValue(input, keyword);
    const typedAt = Date.now();
    let prev = null;
    const view = await waitFor(
      () => {
        const v = categoryDropdown();
        const stable = v.key !== '' && v.key === prev;
        prev = v.key;
        if (!stable) return null;
        const settled = Date.now() - typedAt >= settleMs;
        const fresh = v.items.length > 0 && v.key !== stale;
        return fresh || settled ? v : null;
      },
      { timeout, interval },
    );
    return { ok: true, results: view ? view.items : [] };
  }

  // ---------- 表单结构 ----------
  // 多段数字（ShopAttrMultiInputUnit，纸张尺寸 长×宽）：值是 [{name, unit, value}]，见 src/shared/attr-numbers.js
  const isMultiNumber = (rule) => /multiInputUnit/i.test(String(rule.type || ''));

  function attrKind(rule) {
    const type = String(rule.type || '');
    if (isMultiNumber(rule)) return 'numbers';
    if (/checkbox|multi/i.test(type)) return 'multi';
    if (/select|radio/i.test(type) || (rule.props && (rule.props.options || []).length)) return 'select';
    return 'input';
  }

  /** 多段数字的各段：段名（长、宽）和可选单位（每段的 subOptions） */
  function numberSegments(rule) {
    if (!isMultiNumber(rule)) return undefined;
    return ((rule.props && rule.props.options) || [])
      .filter((o) => o && o.label != null)
      .map((o) => ({
        name: String(o.label),
        units: [...new Set((o.subOptions || []).map((u) => String(u.value ?? u.label ?? '')).filter(Boolean))],
      }));
  }

  function getFormSchema() {
    const api = getFApi();
    if (!api) return { ok: false, error: '发布页表单未就绪' };
    const groups = (api.getRule('productProp').props || {}).template || [];
    const attrs = groups.flatMap((g) =>
      (g.children || []).map((c) => {
        const p = c.props || {};
        const rule = p.rule || {};
        return {
          field: String(c.field),
          title: c.title || '',
          type: c.type,
          kind: attrKind(c),
          required: !!rule.required,
          suffix: p.suffix || '',
          maxLength: rule.max || 0,
          options: (p.options || []).map((o) => ({ label: o.label, value: String(o.value) })),
          segments: numberSegments(c),
        };
      }),
    );
    return { ok: true, attrs, fields: api.fields() };
  }

  // ---------- 商品属性 ----------
  function setProps(values) {
    const api = getFApi();
    const current = api.getValue('productProp') || {};
    api.setValue('productProp', Object.assign({}, current, values));
    const after = api.getValue('productProp') || {};
    const failed = Object.keys(values).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(values[k]));
    return { ok: failed.length === 0, failed };
  }

  function collectErrors() {
    return qsa('.jd-form-item__error')
      .filter(visible)
      .map((err) => {
        const fi = err.closest('.jd-form-item');
        const lab = fi && fi.querySelector('.jd-form-item__label');
        return `${textOf(lab) || '字段'}：${textOf(err)}`;
      });
  }

  NS.backend = Object.assign(NS.backend || {}, {
    __core: true,
    util: { sleep, qsa, visible, textOf, norm, waitFor, setNativeValue, click, buttonByText, visibleDialogs, messages, walkComponents },
    getFApi,
    pinia,
    searchCategory,
    getFormSchema,
    setProps,
    collectErrors,
  });
})();
