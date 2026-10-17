// 注入到京麦商品发布后台（wares-jdm.jd.com，MAIN world）。
// 发布页是 Vue3 + form-create：通过组件树拿到 fApi 直接读写表单值，
// 无法用 fApi 的部分（品牌下拉、销售属性、SKU 表、上传）走 DOM 模拟。
(() => {
  const NS = (window.__JDMOVE__ = window.__JDMOVE__ || {});
  if (NS.backend && NS.backend.__core) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const visible = (el) => !!(el && el.isConnected && (el.offsetParent || el.getClientRects().length));
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[\s:：,，()（）\[\]【】*＊/、\-_.]/g, '');

  async function waitFor(fn, { timeout = 15000, interval = 200 } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        const v = fn();
        if (v) return v;
      } catch {
        /* 页面尚未就绪，继续轮询 */
      }
      await sleep(interval);
    }
    return null;
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

  function formItemByLabel(label, root = document) {
    const want = norm(label);
    return (
      qsa('.jd-form-item', root).find((fi) => {
        const lab = fi.querySelector(':scope > .jd-form-item__label, :scope > label');
        return lab && norm(textOf(lab)) === want && visible(fi);
      }) || null
    );
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

  // ---------- 状态 / 类目 ----------
  function status() {
    const path = location.pathname;
    const page = path.startsWith('/popPublish') ? 'publish' : /categorySelect/.test(path) ? 'category' : 'other';
    const api = page === 'publish' ? getFApi() : null;
    const store = pinia() && pinia().state.value['publish-product'];
    const cat = (document.body.innerText.match(/商品类目\s*\n*\s*([^\n]+)/) || [])[1] || '';
    return {
      page,
      ready: !!(api && api.fields().includes('spuImg')),
      publishDisabled: store ? !!store.publishDisabled : null,
      publishDisabledMsg: store ? store.publishDisabledMsg || '' : '',
      categoryText: cat.trim(),
      loginRequired: /passport\.jd\.com/.test(location.href),
    };
  }

  async function searchCategory(keyword) {
    const input = await waitFor(() => qsa('input').find((i) => /类目名称/.test(i.placeholder || '')));
    if (!input) return { ok: false, error: '找不到类目搜索框', results: [] };
    setNativeValue(input, '');
    await sleep(300);
    input.focus();
    setNativeValue(input, keyword);
    const results = await waitFor(
      () => {
        const items = qsa('li.jd-dropdown-menu__item').filter(visible).map(textOf).filter((t) => /\[\d+\]/.test(t));
        if (items.length) return items;
        return /暂无数据/.test(document.body.innerText) ? [] : null;
      },
      { timeout: 6000 },
    );
    return { ok: true, results: results || [] };
  }

  // ---------- 表单结构 ----------
  function attrKind(rule) {
    const type = String(rule.type || '');
    if (/checkbox|multi/i.test(type)) return 'multi';
    if (/select|radio/i.test(type) || (rule.props && (rule.props.options || []).length)) return 'select';
    return 'input';
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
        };
      }),
    );
    const saleDimNames = [];
    for (const input of qsa('input')) {
      const m = (input.placeholder || '').match(/^请设置(.+)$/);
      if (m && !saleDimNames.includes(m[1])) saleDimNames.push(m[1]);
    }
    return { ok: true, attrs, saleDimNames, fields: api.fields() };
  }

  // ---------- 基础信息 / 品牌 / 属性 ----------
  async function setBasics({ title, weightKg, packList }) {
    const api = getFApi();
    const report = {};
    const titleInput = qsa('input').find((i) => i.placeholder === '请输入商品标题');
    if (titleInput && title) {
      setNativeValue(titleInput, title);
      titleInput.dispatchEvent(new Event('blur'));
    } else if (title) {
      api.setValue('productTitle', Object.assign({}, api.getValue('productTitle'), { title }));
    }
    report.title = (api.getValue('productTitle') || {}).title || '';
    if (weightKg) {
      const fi = formItemByLabel('商品毛重(公斤)');
      const input = fi && fi.querySelector('input');
      if (input) setNativeValue(input, String(weightKg));
      report.weight = input ? input.value : null;
    }
    if (packList) {
      const fi = formItemByLabel('包装清单');
      const ta = fi && fi.querySelector('textarea');
      if (ta) setNativeValue(ta, packList);
      report.packList = ta ? ta.value : null;
    }
    return { ok: !!report.title, report };
  }

  // jd-select 的点击处理挂在内部 wrapper 上；逐个尝试直到下拉出现
  async function openSelect(root) {
    const dropdownShown = () => qsa('.jd-select-dropdown__item').some(visible);
    if (dropdownShown()) return true;
    for (const sel of ['.jd-input__wrapper', '.select-trigger', '.jd-select__wrapper', '.jd-input', 'input']) {
      const target = root.querySelector(sel);
      if (!target) continue;
      // 选择后输入框仍保持焦点，此时点击不会重新展开，需先失焦
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      await sleep(200);
      click(target);
      if (await waitFor(dropdownShown, { timeout: 800 })) return true;
    }
    return false;
  }

  async function selectBrand({ id, name }) {
    const api = getFApi();
    const fi = formItemByLabel('品牌');
    if (!fi) return { ok: false, error: '找不到品牌字段' };
    const input = fi.querySelector('input');
    // 先关闭可能残留的下拉，避免读到上一次的过滤结果
    document.body.click();
    await waitFor(() => !qsa('.jd-select-dropdown__item').some(visible), { timeout: 1500 });
    if (!(await openSelect(fi))) return { ok: false, error: '品牌下拉框无法打开' };
    await sleep(300);
    const keyword = String(name || '').replace(/[（(].*$/, '').trim();
    if (keyword && input) {
      setNativeValue(input, keyword);
      await sleep(1200);
    }
    const want = norm(name);
    const pick = await waitFor(
      () => {
        const items = qsa('.jd-select-dropdown__item').filter(visible);
        const byId = id ? items.find((li) => textOf(li).includes(`[${id}]`)) : null;
        return (
          byId ||
          items.find((li) => norm(textOf(li).replace(/\[\d+\].*$/, '')) === want) ||
          items.find((li) => keyword && norm(textOf(li)).includes(norm(keyword))) ||
          null
        );
      },
      { timeout: 5000 },
    );
    if (!pick) {
      document.body.click();
      return { ok: false, error: `店铺未授权品牌：${name || id}` };
    }
    const label = textOf(pick);
    const pickedId = Number((label.match(/\[(\d+)\]/) || [])[1]) || null;
    click(pick);
    const brandId = await waitFor(() => {
      const v = api.getValue('brandId');
      return v && (!pickedId || Number(v) === pickedId) ? v : null;
    }, { timeout: 4000 });
    return { ok: !!brandId, brandId, label };
  }

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
    util: { sleep, qsa, visible, textOf, norm, waitFor, setNativeValue, click, openSelect, formItemByLabel, buttonByText, visibleDialogs, messages, walkComponents },
    getFApi,
    status,
    searchCategory,
    getFormSchema,
    setBasics,
    selectBrand,
    setProps,
    collectErrors,
  });
})();
