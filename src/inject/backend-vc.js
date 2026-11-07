// 注入到 VC 自营发布页（wares-jdm.jd.com/vcProductPublish，MAIN world）。依赖 backend-core.js、backend-media.js 先注入。
// 页面和 POP 发布页同一套技术（Vue3 + form-create，PublishProduct.setupState.fApi），字段不同：
// 价格/采购员/销售员/长宽高等直接用 fApi.setValue 写；ERP 是自动完成输入框，要选下拉候选才会带出姓名；
// SKU 表没有价格库存列，商品名称/条形码在表格里填，规格和 SKU属性在抽屉里填（见 backend-vc-drawer.js）
(() => {
  const NS = window.__JDMOVE__;
  if (!NS || !NS.backend || !NS.backend.__media || NS.backend.__vc) return;
  const B = NS.backend;
  const { sleep, qsa, visible, textOf, norm, waitFor, setNativeValue, click } = B.util;
  const { componentChain, commitInput } = B.mediaUtil;

  // ---------- 状态 ----------
  function vcStatus() {
    const path = location.pathname;
    const page = /^\/vcProductPublish/.test(path) ? 'vc_publish' : /categorySelect/.test(path) ? 'category' : 'other';
    const api = page === 'vc_publish' ? B.getFApi() : null;
    const fields = api ? api.fields() : [];
    const store = B.pinia() && B.pinia().state.value['publish-product'];
    const cat = (document.body.innerText.match(/商品类目\s*\n*\s*([^\n]+)/) || [])[1] || '';
    return {
      page,
      ready: fields.includes('imageList') && fields.includes('productTitle'),
      publishDisabled: store ? !!store.publishDisabled : null,
      publishDisabledMsg: store ? store.publishDisabledMsg || '' : '',
      categoryText: cat.trim(),
      brandId: api ? api.getValue('brandId') : null,
      loginRequired: /passport\.jd\.com/.test(location.href),
    };
  }

  // ---------- 表单字段 ----------
  function optionsOf(api, field) {
    const rule = api.getRule(field) || {};
    let opts = rule.props && rule.props.options;
    if (typeof opts === 'string') {
      try {
        opts = JSON.parse(opts);
      } catch {
        opts = [];
      }
    }
    if (!Array.isArray(opts) || !opts.length) opts = rule.options || [];
    return opts.filter((o) => o && o.label != null);
  }

  /** 下拉字段按选项文字取值（商品包装“普通商品”→ '1'）；没有选项的字段原样返回 */
  function optionValue(api, field, label) {
    const opts = optionsOf(api, field);
    if (!opts.length) return label;
    const want = norm(label);
    const hit = opts.find((o) => norm(o.label) === want) || opts.find((o) => want && (norm(o.label).includes(want) || want.includes(norm(o.label))));
    return hit ? hit.value : null;
  }

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b) || String(a) === String(b);

  /** 标题：在输入框里输入（页面监听输入框计算字数），写不进去再直接写表单值 */
  async function setTitle(api, title) {
    const input = qsa('input').find((i) => /此标题仅用于|请输入商品标题/.test(i.placeholder || '') && visible(i));
    if (input) {
      setNativeValue(input, title);
      input.dispatchEvent(new Event('blur'));
      await sleep(200);
    }
    if ((api.getValue('productTitle') || {}).title !== title) {
      api.setValue('productTitle', Object.assign({}, api.getValue('productTitle'), { title }));
    }
    return (api.getValue('productTitle') || {}).title === title;
  }

  /**
   * 标题、型号、三个价格、物流售后字段
   * @param {{title: string, model: string, prices: object, logistics: object}} plan
   * @returns {Promise<{ok: boolean, failed: string[], skipped: string[]}>}
   */
  async function vcSetFields({ title, model, prices = {}, logistics = {} }) {
    const api = B.getFApi();
    if (!api) return { ok: false, failed: ['表单未就绪'], skipped: [] };
    const failed = [];
    const skipped = [];
    if (title && !(await setTitle(api, title))) failed.push('标题');
    const fields = api.fields();
    const writes = [
      ['features.model', model, '型号'],
      ['marketPrice', prices.marketPrice, '市场价'],
      ['jdPrice', prices.jdPrice, '京东价'],
      ['costPrice', prices.costPrice, '采购价'],
      ['length', logistics.length, '长'],
      ['wide', logistics.wide, '宽'],
      ['height', logistics.height, '高'],
      ['weight', logistics.weight, '毛重'],
      ['features.sldays', logistics.sldays, '保质期'],
      ['features.unit', logistics.unit, '销售单位'],
      ['packSpecification', logistics.packSpecification, '包装规格'],
      ['features.packType', logistics.packType, '商品包装'],
      ['warranty', logistics.warranty, '质保期'],
      ['packListing', logistics.packListing, '包装清单'],
    ];
    for (const [field, raw, label] of writes) {
      if (raw == null || raw === '') continue;
      if (!fields.includes(field)) {
        skipped.push(label);
        continue;
      }
      const value = optionValue(api, field, raw);
      if (value == null) {
        failed.push(`${label}（没有“${raw}”这个选项）`);
        continue;
      }
      api.setValue(field, value);
      await sleep(50);
      if (!same(api.getValue(field), value)) failed.push(label);
    }
    return { ok: failed.length === 0, failed, skipped };
  }

  // ---------- 采购员 / 销售员 ERP ----------
  const ERP_FIELDS = [
    ['buyerInfo', /采购员ERP/, '采购员'],
    ['salerInfo', /销售员ERP/, '销售员'],
  ];

  /** 在自动完成输入框里输入 ERP，选中完全一致的候选，页面随之查出姓名 */
  async function pickErp(api, field, placeholderRe, code) {
    const input = qsa('input').find((i) => placeholderRe.test(i.placeholder || ''));
    if (!input) return `找不到输入框`;
    input.scrollIntoView({ block: 'center' });
    input.focus();
    click(input);
    setNativeValue(input, code);
    const li = await waitFor(
      () => qsa('.jd-autocomplete-suggestion__list li').find((x) => visible(x) && norm(textOf(x)) === norm(code)),
      { timeout: 6000 },
    );
    if (!li) {
      input.blur();
      return `没有找到 ERP“${code}”`;
    }
    li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    click(li);
    const ok = await waitFor(() => (api.getValue(field) || {}).erpCode === code && (api.getValue(field) || {}).erpName, { timeout: 5000 });
    input.blur();
    return ok ? '' : '选中后没有带出姓名';
  }

  /**
   * 采购员和销售员填同一个 ERP（用户的 5 个手动字段之二）
   * @returns {Promise<{ok: boolean, people: string[], errors: string[]}>} people：页面上最终的“姓名(ERP)”
   */
  async function vcSetErp(code) {
    const api = B.getFApi();
    if (!api) return { ok: false, people: [], errors: ['表单未就绪'] };
    const errors = [];
    for (const [field, re, label] of ERP_FIELDS) {
      const current = api.getValue(field) || {};
      if (current.erpCode === code && current.erpName) continue;
      const err = await pickErp(api, field, re, code);
      if (err) errors.push(`${label}：${err}`);
    }
    const people = ERP_FIELDS.map(([field, , label]) => {
      const v = api.getValue(field) || {};
      return `${label} ${v.erpName || '—'}(${v.erpCode || '—'})`;
    });
    return { ok: errors.length === 0, people, errors };
  }

  // ---------- 本地校验 ----------
  // 校验结果里的键不一定是字段名（图片信息识别报在 recProduct 上）
  const ERROR_TITLES = { recProduct: '图片信息识别' };

  /** 只跑页面表单的本地校验（不提交），返回每个字段的错误 */
  async function vcValidate() {
    const api = B.getFApi();
    try {
      await api.validate();
      return { ok: true, errors: [] };
    } catch (e) {
      const entries = e && typeof e === 'object' ? Object.entries(e) : [['表单', e]];
      const errors = entries.map(([key, list]) => {
        const rule = api.getRule(key);
        const title = ERROR_TITLES[key] || (rule && typeof rule.title === 'string' ? rule.title : key);
        const msgs = Array.isArray(list) ? list.map((x) => (x && x.message) || String(x)) : [String((list && list.message) || list)];
        return `${title}：${[...new Set(msgs)].join('/')}`;
      });
      return { ok: false, errors };
    }
  }

  // ---------- SKU 表 ----------
  const UPC_PLACEHOLDER_RE = /商品条形码/;

  /** SKU 表的行：VC 表格每行都有一个条形码输入框 */
  function vcSkuRows() {
    return qsa('tr').filter((tr) => visible(tr) && qsa('input', tr).some((i) => UPC_PLACEHOLDER_RE.test(i.placeholder || '')));
  }

  /** 表格组件里的行数据（skuName 等）；新发布页的表单 skus 要到保存时才生成，只能从组件读 */
  function vcSkuTableData() {
    const row = vcSkuRows()[0];
    const input = row && row.querySelector('input, textarea');
    let c = input && input.__vueParentComponent;
    for (let i = 0; c && i < 16; i += 1, c = c.parent) {
      if (c.props && Array.isArray(c.props.tableData)) return c.props.tableData;
    }
    return null;
  }

  const cellOf = (tr, componentName, tag = 'input, textarea') =>
    qsa(tag, tr).find((el) => componentChain(el, 3).includes(componentName)) || null;

  /**
   * 第 rowIndex 行的商品名称、商品条形码
   * @returns {Promise<{ok: boolean, errors: string[], upcNotice: string}>} upcNotice：页面对条形码的提示（如重码，可正常发品）
   */
  async function vcSetSkuRow({ rowIndex = 0, name, upc }) {
    const tr = vcSkuRows()[rowIndex];
    if (!tr) return { ok: false, errors: [`找不到 SKU 表第 ${rowIndex + 1} 行`], upcNotice: '' };
    tr.scrollIntoView({ block: 'center' });
    const errors = [];
    const nameBox = cellOf(tr, 'Title', 'textarea');
    if (name && nameBox) {
      commitInput(nameBox, name);
      await sleep(300);
      const data = vcSkuTableData();
      if (data && data[rowIndex] && data[rowIndex].skuName !== name) errors.push('商品名称没有写进去');
    } else if (name) errors.push('找不到商品名称输入框');
    let upcNotice = '';
    const upcBox = qsa('input', tr).find((i) => UPC_PLACEHOLDER_RE.test(i.placeholder || ''));
    if (upc && upcBox) {
      commitInput(upcBox, upc);
      // 页面会查重码：有重复只提示“可正常发品但入仓需贴码”，不拦
      await sleep(2500);
      const cell = upcBox.closest('td') || upcBox.parentElement;
      upcNotice = (textOf(cell).match(/检测到[^【]*/) || [''])[0].trim();
      if (upcBox.value !== upc) errors.push('商品条形码没有写进去');
    }
    return { ok: errors.length === 0, errors, upcNotice };
  }

  /** 第 rowIndex 行规格、SKU属性单元格当前显示的内容（“已设置8项”），保存前核对用 */
  function vcSkuRowState(rowIndex = 0) {
    const tr = vcSkuRows()[rowIndex];
    if (!tr) return { ok: false };
    const spec = cellOf(tr, 'SaleDrawer');
    const attrs = cellOf(tr, 'ShopSkuAttributeCommon');
    const data = vcSkuTableData();
    return {
      ok: true,
      rows: vcSkuRows().length,
      skuName: data && data[rowIndex] ? data[rowIndex].skuName || '' : '',
      spec: spec ? spec.value : '',
      attrs: attrs ? attrs.value : '',
    };
  }

  Object.assign(B, {
    __vc: true,
    vcUtil: { optionsOf, vcSkuRows, cellOf },
    vcStatus,
    vcSetFields,
    vcSetErp,
    vcValidate,
    vcSetSkuRow,
    vcSkuRowState,
  });
})();
