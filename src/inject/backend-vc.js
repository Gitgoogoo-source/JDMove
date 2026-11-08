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
  // 发布页打不开时整页换成“信息展示异常”：.err-page .err-msg 是原因 + 时间（“您选择的类目不是末级类目; 2026-11-08 19:02:12”）
  const ERR_MSG_SEL = '.err-page .err-msg';
  const ERR_TIME_RE = /[;；]\s*\d{4}-\d{2}-\d{2}[\d\s:]*$/;
  const NOT_LEAF_RE = /不是末级类目/;

  function pageErrorText() {
    const el = qsa(ERR_MSG_SEL).find(visible);
    return el ? textOf(el).replace(ERR_TIME_RE, '').trim() : '';
  }

  /**
   * @returns {{page: string, ready: boolean, pageError: string, notLeaf: boolean, publishDisabled: boolean|null,
   *   publishDisabledMsg: string, categoryText: string, brandId: unknown, loginRequired: boolean}}
   *   pageError：页面显示的打不开原因；notLeaf：原因是类目不是末级类目
   */
  function vcStatus() {
    const path = location.pathname;
    const page = /^\/vcProductPublish/.test(path) ? 'vc_publish' : /categorySelect/.test(path) ? 'category' : 'other';
    const api = page === 'vc_publish' ? B.getFApi() : null;
    const fields = api ? api.fields() : [];
    const store = B.pinia() && B.pinia().state.value['publish-product'];
    const cat = (document.body.innerText.match(/商品类目\s*\n*\s*([^\n]+)/) || [])[1] || '';
    const pageError = page === 'vc_publish' ? pageErrorText() : '';
    return {
      page,
      ready: fields.includes('imageList') && fields.includes('productTitle'),
      pageError,
      notLeaf: NOT_LEAF_RE.test(pageError),
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
   * 写一个字段：值一律是字符串（和在输入框里手动输入一样）；下拉字段按选项文字换成页面的选项值。
   * 写完严格读回比较（类型也要一致）：页面把值改成数字或别的格式时算没写进去
   * @returns {string} 空串 = 写好了；否则为失败原因
   */
  async function writeField(api, { field, label, value }) {
    const text = String(value);
    // 没有选项的字段 optionValue 原样返回字符串；下拉字段用页面自己的选项值，不改类型
    const want = optionValue(api, field, text);
    if (want == null) return `${label}（没有“${text}”这个选项）`;
    api.setValue(field, want);
    await sleep(50);
    const got = api.getValue(field);
    if (got === want) return '';
    return `${label}（写入“${want}”，页面上是 ${JSON.stringify(got)}）`;
  }

  /**
   * 标题 + 计划里按页面格式转好的字段（型号、价格、长宽高、毛重、物流售后），见 shared/vc-form-values.js
   * @param {{title: string, entries: {field: string, label: string, value: string, critical: boolean}[]}} plan
   * @returns {Promise<{ok: boolean, failed: string[], skipped: string[]}>}
   *   failed：没写进去的（“标签（原因）”）；skipped：页面上没有这个字段
   */
  async function vcSetFields({ title, entries = [] }) {
    const api = B.getFApi();
    if (!api) return { ok: false, failed: ['表单未就绪'], skipped: [] };
    const failed = [];
    const skipped = [];
    if (title && !(await setTitle(api, title))) failed.push('标题');
    const fields = api.fields();
    for (const entry of entries) {
      if (entry.value == null || entry.value === '') continue;
      if (!fields.includes(entry.field)) {
        skipped.push(entry.label);
        continue;
      }
      const err = await writeField(api, entry);
      if (err) failed.push(err);
    }
    return { ok: failed.length === 0, failed, skipped };
  }

  // ---------- 保存前检查提交数据 ----------
  // 保存草稿/发布商品都先调 PublishProduct 的 convertData() 把表单转成提交数据（只读，不发请求）。
  // 这里用同一个函数生成提交数据，检查插件写过的字段是不是字符串；带小数的 JS 数字会被网关拒收（[455]/[456]）
  function publishProductSetup() {
    const api = B.getFApi();
    const inst = api && api.fields().includes('productTitle') ? api.el('productTitle') : null;
    let c = inst && inst.$ && inst.$.parent;
    for (let i = 0; c && i < 40; i += 1, c = c.parent) {
      if ((c.type.name || c.type.__name) === 'PublishProduct' && c.setupState) return c.setupState;
    }
    return null;
  }

  const PAYLOAD_SYNC_MS = 300;
  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

  /** 提交数据里所有带小数的 JS 数字的路径（最多 20 个） */
  function floatPaths(obj, prefix = '', out = [], depth = 0) {
    if (out.length >= 20 || depth > 6 || obj == null || typeof obj !== 'object') return out;
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v)) out.push(`${path}=${v}`);
      else if (v && typeof v === 'object') floatPaths(v, path, out, depth + 1);
    }
    return out;
  }

  /**
   * @param {{fields: {field: string, label: string}[]}} input 插件写过的字段
   * @returns {Promise<{ok: boolean, problems: string[], floats: string[], error?: string}>}
   *   problems：插件写过、但提交数据里变成带小数数字的字段；floats：提交数据里所有带小数的数字（只提醒）
   */
  async function vcPayloadCheck({ fields = [] } = {}) {
    // setValue 之后表单数据要到下一轮才同步进 convertData（实测立刻调用读到的全是 null）
    await sleep(PAYLOAD_SYNC_MS);
    const setup = publishProductSetup();
    if (!setup || typeof setup.convertData !== 'function') return { ok: true, problems: [], floats: [], error: '页面没有 convertData，跳过检查' };
    let data;
    try {
      data = setup.convertData();
    } catch (e) {
      return { ok: true, problems: [], floats: [], error: `生成提交数据失败：${String((e && e.message) || e)}` };
    }
    // 实测会被拒收的是带小数的数字（毛重 4.33）；整数（下拉的选项值）不算问题
    const problems = fields
      .map(({ field, label }) => [label, getPath(data, field)])
      .filter(([, v]) => typeof v === 'number' && !Number.isInteger(v))
      .map(([label, v]) => `${label}=${v}（数字）`);
    return { ok: problems.length === 0, problems, floats: floatPaths(data) };
  }

  // ---------- 采购员 / 销售员 ERP ----------
  const ERP_FIELDS = [
    ['buyerInfo', /采购员ERP/, '采购员', 'buyer'],
    ['salerInfo', /销售员ERP/, '销售员', 'saler'],
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
   * 采购员 / 销售员 ERP（用户的 5 个手动字段之二）。codes 为字符串时两个字段填同一个（旧调用方式）；
   * 对象里没给的字段不动，沿用页面默认值
   * @param {string | {buyer?: string, saler?: string}} codes
   * @returns {Promise<{ok: boolean, people: string[], errors: string[]}>} people：页面上最终的“姓名(ERP)”
   */
  async function vcSetErp(codes) {
    const api = B.getFApi();
    if (!api) return { ok: false, people: [], errors: ['表单未就绪'] };
    const want = typeof codes === 'string' ? { buyer: codes, saler: codes } : codes || {};
    const errors = [];
    for (const [field, re, label, key] of ERP_FIELDS) {
      const code = String(want[key] || '').trim();
      if (!code) continue;
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

  // ---------- 图片信息识别的状态 ----------
  // 放好图片还不够，要点“开始识别”且识别成功；页面只在点“发布商品”时才查这一项（没识别报“请先进行图片识别”）。
  // 识别组件 AIPublishNew 的 recognizeDisabled 就是页面的“已识别”标记（成功后按钮置灰，换图会重置）；
  // intelligentPublish（从智能发品进来的页面）不需要识别；识别进行中 PublishProduct.isAIReload 为 true
  const AI_REC_FIELD = 'aiRecImages';
  const NOT_RECOGNIZED_MSG = '请先进行图片识别';

  /** @returns {{recognized: boolean, reloading: boolean, images: number} | null} null：页面没有这个组件 */
  function aiRecState(api) {
    const inst = api && api.fields().includes(AI_REC_FIELD) ? api.el(AI_REC_FIELD) : null;
    const box = inst && inst.$el && inst.$el.querySelector('.ai-publish');
    const comp = box && box.__vueParentComponent;
    if (!comp || !comp.props || !('recognizeDisabled' in comp.props)) return null;
    let page = comp.parent;
    while (page && (page.type.name || page.type.__name) !== 'PublishProduct') page = page.parent;
    return {
      recognized: !!(comp.props.recognizeDisabled || comp.props.intelligentPublish),
      reloading: !!(page && page.setupState && page.setupState.isAIReload),
      images: qsa('.sortable-list img', inst.$el).filter(visible).length,
    };
  }

  // ---------- 本地校验 ----------
  // 校验结果里的键不一定是字段名（图片信息识别报在 recProduct 上）
  const ERROR_TITLES = { recProduct: '图片信息识别' };

  function formErrors(api, e) {
    const entries = e && typeof e === 'object' ? Object.entries(e) : [['表单', e]];
    return entries.map(([key, list]) => {
      const rule = api.getRule(key);
      const title = ERROR_TITLES[key] || (rule && typeof rule.title === 'string' ? rule.title : key);
      const msgs = Array.isArray(list) ? list.map((x) => (x && x.message) || String(x)) : [String((list && list.message) || list)];
      return `${title}：${[...new Set(msgs)].join('/')}`;
    });
  }

  /** 只跑页面表单的本地校验（不提交），返回每个字段的错误；“图片识别过没有”本地校验查不到，单独补上 */
  async function vcValidate() {
    const api = B.getFApi();
    let errors = [];
    try {
      await api.validate();
    } catch (e) {
      errors = formErrors(api, e);
    }
    const rec = aiRecState(api);
    const recTitle = ERROR_TITLES.recProduct;
    if (rec && rec.images && !rec.recognized && !errors.some((x) => x.startsWith(`${recTitle}：`))) {
      errors = [...errors, `${recTitle}：${NOT_RECOGNIZED_MSG}`];
    }
    return { ok: errors.length === 0, errors };
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
    vcUtil: { optionsOf, vcSkuRows, cellOf, aiRecState },
    vcStatus,
    vcSetFields,
    vcPayloadCheck,
    vcSetErp,
    vcValidate,
    vcSetSkuRow,
    vcSkuRowState,
  });
})();
