// 发布页：图片上传、销售属性、SKU 表、商品详情、提交动作（MAIN world）。
// 依赖 backend-core.js 先注入。
(() => {
  const NS = window.__JDMOVE__;
  if (!NS || !NS.backend || NS.backend.__media) return;
  const B = NS.backend;
  const { sleep, qsa, visible, textOf, norm, waitFor, setNativeValue, click, openSelect, buttonByText, visibleDialogs, messages } = B.util;

  function b64ToFile({ b64, name, mime }) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime || 'image/jpeg' });
  }

  function componentChain(el, depth = 16) {
    const names = [];
    let c = el.__vueParentComponent;
    for (let i = 0; i < depth && c; i += 1) {
      names.push(c.type.name || c.type.__name || '');
      c = c.parent;
    }
    return names;
  }

  function putFiles(input, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 捕获图片空间上传接口的返回（data.imgUrl / data.imgName）
  function installUploadCapture() {
    if (NS.__uploadCapture) return NS.__uploadCapture;
    const captured = [];
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function send(body) {
      this.addEventListener('load', () => {
        try {
          const data = JSON.parse(this.responseText);
          const d = data && data.data;
          if (d && typeof d.imgUrl === 'string' && /^jfs\//.test(d.imgUrl)) captured.push({ name: d.imgName, url: d.imgUrl, at: Date.now() });
        } catch {
          /* 非 JSON 响应忽略 */
        }
      });
      return origSend.call(this, body);
    };
    NS.__uploadCapture = captured;
    return captured;
  }

  // ---------- 主图 ----------
  async function uploadMainImages(images) {
    const api = B.getFApi();
    const input = qsa('input[type=file]').find((i) => {
      const chain = componentChain(i);
      return chain.includes('DragDropUploader') && chain.includes('shop-main-img');
    });
    if (!input) return { ok: false, error: '找不到主图上传控件', urls: [] };
    api.setValue('spuImg', Object.assign({}, api.getValue('spuImg'), { imageMap: [] }));
    await sleep(500);
    const urls = [];
    const errors = [];
    for (const img of images) {
      const before = (api.getValue('spuImg').imageMap || []).length;
      putFiles(input, [b64ToFile(img)]);
      const ok = await waitFor(() => (api.getValue('spuImg').imageMap || []).length > before, { timeout: 30000 });
      if (!ok) {
        errors.push(`${img.name} 上传失败 ${messages().join(' ')}`.trim());
        continue;
      }
      const map = api.getValue('spuImg').imageMap;
      urls.push(map[map.length - 1].imgUrl);
    }
    // 按原顺序重写 imgIndex
    const ordered = urls.map((imgUrl, i) => ({ colorId: '0000000000', imgIndex: i + 1, imgUrl }));
    api.setValue('spuImg', Object.assign({}, api.getValue('spuImg'), { imageMap: ordered }));
    return { ok: urls.length > 0, urls, errors };
  }

  // ---------- 销售属性 ----------
  const saleInputs = (dimName) => qsa('input').filter((i) => i.placeholder === `请设置${dimName}`);

  // 京麦销售属性组件的值：[{ attrValueAlias, specType: 'temporary' | 'formal' }]；拿不到组件时返回 null
  function saleDimState(dimName) {
    let c = (saleInputs(dimName)[0] || {}).__vueParentComponent;
    for (let i = 0; i < 20 && c; i += 1) {
      if ((c.type.name || c.type.__name) === 'SaleDimensionContainer') return Array.isArray(c.props.modelValue) ? c.props.modelValue : null;
      c = c.parent;
    }
    return null;
  }

  function saleValueCommitted(dimName, value) {
    const state = saleDimState(dimName);
    if (!state) return saleInputs(dimName).some((i) => i.value === value);
    return state.some((v) => v.attrValueAlias === value && v.specType !== 'temporary');
  }

  // 窗口没有系统焦点（切到别的应用、窗口被遮挡）时 focus()/blur() 不触发事件，京麦收不到失焦；
  // 原生 blur 没触发时补发一个合成的 blur（Vue 的监听对合成事件同样生效）
  async function blurInput(el) {
    let fired = false;
    const mark = () => {
      fired = true;
    };
    el.addEventListener('blur', mark);
    el.focus();
    await sleep(100);
    el.blur();
    el.removeEventListener('blur', mark);
    if (!fired) el.dispatchEvent(new FocusEvent('blur'));
  }

  // 录入的值先是“临时”值，只有持有该值的输入框失焦后才转为正式值并重建 SKU 表，合成的回车事件不会提交。
  // 不提交的话，后面填的京东价/库存写在一张没有规格的占位表上，之后整表重建时被清空。
  // 页面忙（刚传完主图）时输入框可能正在重渲染，每次重试都重新找持有该值的输入框
  async function commitSaleValue(dimName, value, { attempts = 3, timeout = 3000 } = {}) {
    for (let i = 0; i < attempts; i += 1) {
      const holder = saleInputs(dimName).find((x) => x.value === value);
      if (!holder) return saleValueCommitted(dimName, value);
      await blurInput(holder);
      if (await waitFor(() => saleValueCommitted(dimName, value), { timeout })) return true;
    }
    return false;
  }

  async function addSaleValue(dimName, value) {
    const empty = saleInputs(dimName).filter((i) => !i.value && visible(i)).pop();
    if (!empty) return false;
    click(empty);
    await sleep(300);
    setNativeValue(empty, value);
    await sleep(300);
    return commitSaleValue(dimName, value);
  }

  async function setSaleValues(dims, { stableMs = 1500 } = {}) {
    const failed = [];
    const uncommitted = [];
    for (const dim of dims) {
      for (const value of dim.values) {
        if (saleDimState(dim.name) && saleValueCommitted(dim.name, value)) continue;
        const typed = saleInputs(dim.name).some((i) => i.value === value);
        const ok = typed ? await commitSaleValue(dim.name, value) : await addSaleValue(dim.name, value);
        if (!ok) uncommitted.push(`${dim.name}:${value}`);
      }
    }
    const expected = dims.reduce((n, d) => n * Math.max(1, d.values.length), 1);
    const rows = await waitFor(() => (skuRows().length === expected ? expected : null), { timeout: 5000 });
    if (!rows) failed.push(`SKU 行数 ${skuRows().length}，预期 ${expected}`);
    await waitSkuTableStable({ quietMs: stableMs });
    return { ok: failed.length === 0 && uncommitted.length === 0, failed: [...uncommitted, ...failed], uncommitted, rows: skuRows().length };
  }

  // ---------- SKU 表 ----------
  function skuRows() {
    return qsa('tr').filter((tr) => visible(tr) && tr.querySelectorAll('input[placeholder="请输入"]').length >= 2 && tr.querySelector('.jd-switch'));
  }

  // 加完规格值后京麦会异步重建 SKU 表（整行换新，已填的京东价/库存被清空）：等行不再变化再填写
  async function waitSkuTableStable({ quietMs = 1500, timeout = 8000, interval = 200 } = {}) {
    const signature = () => skuRows().map((tr) => (tr.querySelector('input') || {}).id || '').join('|');
    const end = Date.now() + timeout;
    let last = signature();
    let since = Date.now();
    while (Date.now() < end) {
      await sleep(interval);
      const current = signature();
      if (current !== last) {
        last = current;
        since = Date.now();
      } else if (Date.now() - since >= quietMs) return true;
    }
    return false;
  }

  // 京麦的价格/库存输入框失焦后才把值提交到表单数据，只触发 input 不够
  function commitInput(el, value) {
    setNativeValue(el, value);
    el.dispatchEvent(new Event('blur'));
  }

  async function batchApply(price, stock) {
    const priceInput = qsa('input').find((i) => i.placeholder === '京东价(元)' && visible(i));
    const stockInput = qsa('input').find((i) => i.placeholder === '库存' && visible(i));
    const btn = buttonByText('批量应用');
    if (!priceInput || !stockInput || !btn) return false;
    commitInput(priceInput, String(price));
    commitInput(stockInput, String(stock));
    click(btn);
    await sleep(800);
    return true;
  }

  async function setSkuRows(rows) {
    const enabled = rows.filter((r) => r.enabled);
    if (enabled.length) await batchApply(enabled[0].price, enabled[0].stock);
    const domRows = skuRows();
    const issues = [];
    if (domRows.length !== rows.length) issues.push(`页面 SKU 行数 ${domRows.length} 与计划 ${rows.length} 不一致`);
    rows.forEach((row, idx) => {
      const tr = domRows[idx];
      if (!tr) return;
      tr.scrollIntoView({ block: 'center' });
      const [priceInput, stockInput] = tr.querySelectorAll('input[placeholder="请输入"]');
      if (row.enabled) commitInput(priceInput, String(row.price));
      commitInput(stockInput, String(row.stock));
      const sw = tr.querySelector('.jd-switch');
      const on = sw.classList.contains('is-checked');
      if (on !== row.enabled) click(sw);
    });
    await sleep(500);
    const missing = rowsNotWritten(rows);
    if (missing.length) issues.push(`第 ${missing.map((m) => m.row + 1).join('、')} 行的京东价/库存没有写进去`);
    return { ok: issues.length === 0, issues, missing, rows: domRows.length };
  }

  const priceInputOf = (tr) => tr.querySelectorAll('input[placeholder="请输入"]')[0];
  const skuEnabled = (tr) => tr.querySelector('.jd-switch').classList.contains('is-checked');

  /**
   * 编辑页上已启用 SKU 的行和当前京东价。SKU 表和原价格是异步加载的：等价格出现、表格稳定后再读，
   * 价格一直没加载出来时报错，而不是在空表上改价（随后加载的数据会把新价格覆盖掉）
   */
  async function enabledSkuPrices({ loadTimeout = 15000 } = {}) {
    const loaded = await waitFor(() => skuRows().some((tr) => priceInputOf(tr).value !== ''), { timeout: loadTimeout });
    const rows = skuRows();
    if (!rows.length) return { error: '页面上没有找到 SKU 价格表' };
    if (!loaded) return { error: '编辑页上的京东价一直没有加载出来' };
    await waitSkuTableStable({ quietMs: 1000, timeout: 8000 });
    const targets = skuRows().filter(skuEnabled);
    if (!targets.length) return { error: '页面上的 SKU 都没有启用' };
    return { targets, prices: targets.map((tr) => priceInputOf(tr).value) };
  }

  /** 只读：编辑页上已启用 SKU 的京东价（改价前核对是不是这个商品、改价后核对是否生效） */
  async function readSkuPrices(opts) {
    const res = await enabledSkuPrices(opts);
    return res.error ? { ok: false, error: res.error, prices: [] } : { ok: true, prices: res.prices };
  }

  // 改价（商品编辑页）：把已启用的 SKU 行的京东价统一改成 price，库存和规格不动
  async function setSkuPrices(price, opts) {
    const res = await enabledSkuPrices(opts);
    if (res.error) return { ok: false, error: res.error, rows: 0, before: [] };
    const { targets, prices: before } = res;
    for (const tr of targets) {
      tr.scrollIntoView({ block: 'center' });
      commitInput(priceInputOf(tr), String(price));
    }
    await sleep(500);
    const failed = targets.flatMap((tr, i) => (Number(priceInputOf(tr).value) === Number(price) ? [] : [i + 1]));
    return { ok: failed.length === 0, error: failed.length ? `第 ${failed.join('、')} 个 SKU 的京东价没有写进去` : '', rows: targets.length, before };
  }

  // 重新读取页面：京东价/库存与计划不一致（被页面清空或没写进去）的行
  function rowsNotWritten(rows) {
    const domRows = skuRows();
    const same = (input, want) => input.value !== '' && Number(input.value) === Number(want);
    return rows.flatMap((row, idx) => {
      const tr = domRows[idx];
      if (!tr) return [];
      const [priceInput, stockInput] = tr.querySelectorAll('input[placeholder="请输入"]');
      const ok = (!row.enabled || same(priceInput, row.price)) && same(stockInput, row.stock);
      return ok ? [] : [{ row: idx, price: String(row.price), stock: String(row.stock) }];
    });
  }

  /** 只读：京东价/库存与计划不一致的行（填完 SKU属性后、保存前最后核对一次） */
  function checkSkuRows(rows) {
    return { missing: rowsNotWritten(rows) };
  }

  // SKU属性列（field=skuProps）里的必填项；字段 id 与表单 skus[i].skuProps 的键一致
  function skuAttrRequiredFields() {
    const store = B.pinia && B.pinia() && B.pinia().state.value['publish-product'];
    const columns = (store && store.saleAttrConfig && store.saleAttrConfig.skuTableColumn) || [];
    const column = columns.find((c) => c && (c.field === 'skuProps' || c.componentCode === 'SkuAttr'));
    if (!column) return [];
    return (column.children || []).flatMap((group) =>
      (group.children || [])
        .filter((f) => f.field != null && (group.componentCode === 'ATTR_REQUIRED' || (f.props && f.props.rule && f.props.rule.required)))
        .map((f) => ({ field: String(f.field), label: f.title || String(f.field) })),
    );
  }

  // SKU 表组件的当前数据（每行的 skuProps 是抽屉点“确定”后写入的）。新发布页上表单 skus 要到保存时才生成，
  // 保存前一直是空数组，只能从表格组件读；草稿/编辑页上两者一致
  function skuTableData() {
    const cell = qsa('.shop-sku-attribute')[0];
    let c = cell && cell.__vueParentComponent;
    for (let i = 0; c && i < 12; i += 1, c = c.parent) {
      if (c.props && Array.isArray(c.props.tableData)) return c.props.tableData;
    }
    return null;
  }

  /** 只读：每行 SKU属性的当前值，保存前用来核对必填项有没有真的写进去 */
  function readSkuAttrState() {
    const api = B.getFApi();
    const table = skuTableData();
    const formSkus = api && api.getValue('skus');
    const rows = table && table.length ? table : formSkus;
    if (!Array.isArray(rows) || !rows.length) return { ok: false, error: '读不到 SKU 表数据' };
    const skuProps = rows.map((s) => (s && s.skuProps ? JSON.parse(JSON.stringify(s.skuProps)) : null));
    return { ok: true, required: skuAttrRequiredFields(), skuProps };
  }

  function matchLabelValue(label, valueMap) {
    const want = norm(label);
    const keys = Object.keys(valueMap);
    const exact = keys.find((k) => norm(k) === want);
    if (exact) return valueMap[exact];
    const near = keys.find((k) => norm(k).length >= 2 && (want.includes(norm(k)) || norm(k).includes(want)));
    return near ? valueMap[near] : null;
  }

  async function chooseSelectOption(fi, value) {
    await openSelect(fi);
    const items = await waitFor(() => {
      const list = qsa('.jd-select-dropdown__item').filter(visible);
      return list.length ? list : null;
    }, { timeout: 3000 });
    const hit = items && (items.find((li) => norm(textOf(li)) === norm(value)) || items.find((li) => norm(textOf(li)).includes(norm(value))));
    if (hit) click(hit);
    else document.body.click();
    return !!hit;
  }

  // SKU属性抽屉的字段：旧版 .jd-form-item；新版 .shop-dynamic-component（标题带 is-required-star 表示必填）
  function drawerFields(drawer) {
    const legacy = qsa('.jd-form-item', drawer).map((fi) => {
      const lab = fi.querySelector('.jd-form-item__label');
      return { root: fi, label: textOf(lab).replace(/[*＊]/g, ''), required: fi.classList.contains('is-required') || /\*/.test(textOf(lab)) };
    });
    const dynamic = qsa('.shop-dynamic-component-title', drawer).map((title) => ({
      root: title.parentElement,
      label: textOf(title).replace(/[*＊]/g, ''),
      required: title.classList.contains('is-required-star'),
    }));
    return [...legacy, ...dynamic].filter((f) => f.root && f.label);
  }

  // 逐个字段填写；返回实际写入的标签和仍为空的必填项
  async function fillDrawerFields(drawer, valueMap) {
    const filled = [];
    const missing = [];
    for (const { root: fi, label, required } of drawerFields(drawer)) {
      const value = matchLabelValue(label, valueMap);
      const input = fi.querySelector('input.jd-input__inner:not([readonly]), textarea');
      let done = false;
      if (value != null && input && !input.value) {
        commitInput(input, String(value));
        done = true;
      } else if (value != null && fi.querySelector('.jd-select')) {
        done = await chooseSelectOption(fi, value);
      } else if (input && input.value) done = true;
      if (done && value != null) filled.push(label);
      if (!done && required) missing.push(label);
    }
    return { filled, missing };
  }

  // 京麦的数字输入框（如建议零售价）失焦后过一会儿才把值写进表单：立刻点“确定”会报“请输入…”、抽屉不关。
  // 所以点之前先等一下，被拦下就再等再点；几次都关不上才点“取消”（抽屉里已填的值随之丢弃）
  const DRAWER_SETTLE_MS = 500;
  const DRAWER_CONFIRM_TRIES = 3;
  async function confirmDrawer(drawer) {
    for (let i = 0; i < DRAWER_CONFIRM_TRIES; i += 1) {
      await sleep(DRAWER_SETTLE_MS);
      const ok = buttonByText('确定', drawer);
      if (ok) click(ok);
      if (await waitFor(() => !visible(drawer), { timeout: 2500 })) return true;
    }
    const cancel = buttonByText('取消', drawer);
    if (cancel) click(cancel);
    await sleep(500);
    return false;
  }

  async function fillSkuAttrDrawers(valueMap) {
    const results = [];
    const count = skuRows().length;
    for (let idx = 0; idx < count; idx += 1) {
      const tr = skuRows()[idx];
      // 设置过的行显示“已设置N项”，按组件找入口，找不到再按文字找
      const trigger = tr && (tr.querySelector('.shop-sku-attribute input') || qsa('input', tr).find((i) => i.placeholder === 'SKU属性' || i.value === 'SKU属性'));
      if (!trigger) continue;
      tr.scrollIntoView({ block: 'center' });
      click(trigger);
      const drawer = await waitFor(() => qsa('.jd-drawer').find((d) => visible(d) && /SKU属性/.test(textOf(d))), { timeout: 5000 });
      if (!drawer) {
        results.push({ row: idx, confirmed: false, error: '未打开SKU属性面板', filled: [], missing: [] });
        continue;
      }
      const { filled, missing } = await fillDrawerFields(drawer, valueMap);
      const confirmed = await confirmDrawer(drawer);
      results.push({ row: idx, confirmed, filled, missing });
    }
    return { ok: results.every((r) => r.confirmed && r.missing.length === 0), results };
  }

  // ---------- 商品详情 ----------
  function descriptionSection() {
    return qsa('.shop-editor_content-right, [class*="shop-editor"]').find(visible) || document;
  }

  // 详情编辑模式按单选框的值识别：文字会带角标（如“图文编辑推荐”），值是稳定的
  const DESC_MODE_VALUES = { 图文编辑: 'FLOOR', 代码编辑: 'CODE', 高级编辑: 'ZHUANG_BA' };

  function descModeRadio(label) {
    const radios = qsa('label.jd-radio', descriptionSection()).concat(qsa('label.jd-radio').filter(visible));
    const valueOf = (l) => (l.querySelector('input.jd-radio__original') || {}).value;
    return (
      radios.find((l) => valueOf(l) === DESC_MODE_VALUES[label]) ||
      radios.find((l) => textOf(l).startsWith(label)) ||
      null
    );
  }

  // 图文编辑里有内容时会弹“是否切换…模式？”确认框；页面忙时它会晚几秒才出来，
  // 所以确认框和选中状态放在同一个等待里看，确认框还开着就不算切换完成
  async function switchDescMode(label, { timeout = 8000 } = {}) {
    const radio = descModeRadio(label);
    if (!radio) return false;
    if (radio.classList.contains('is-checked')) return true;
    click(radio);
    let confirmed = false;
    return !!(await waitFor(() => {
      const box = visibleDialogs().find((d) => /切换/.test(textOf(d)));
      if (!box) return radio.classList.contains('is-checked');
      const ok = !confirmed && buttonByText('确定', box);
      if (ok) {
        click(ok);
        confirmed = true;
      }
      return false;
    }, { timeout }));
  }

  async function uploadDetailImages(images) {
    const captured = installUploadCapture();
    if (!(await switchDescMode('图文编辑'))) return { ok: false, error: '无法切换到图文编辑模式', urls: [] };
    const addBtn = await waitFor(() => buttonByText('添加图片', descriptionSection()) || buttonByText('添加图片'));
    if (!addBtn) return { ok: false, error: '找不到“添加图片”按钮', urls: [] };
    click(addBtn);
    const dialog = await waitFor(() => visibleDialogs().find((d) => /图片空间/.test(textOf(d))), { timeout: 8000 });
    if (!dialog) return { ok: false, error: '图片空间未打开', urls: [] };
    const input = await waitFor(() => qsa('input[type=file]').find((i) => componentChain(i, 2).includes('upload-button')));
    const urls = [];
    const errors = [];
    for (const img of images) {
      const startAt = Date.now();
      putFiles(input, [b64ToFile(img)]);
      const hit = await waitFor(() => captured.find((c) => c.name === img.name && c.at >= startAt - 1000), { timeout: 30000 });
      if (hit) urls.push(hit.url);
      else errors.push(`${img.name} 上传超时 ${messages().join(' ')}`.trim());
      await sleep(300);
    }
    const cancel = buttonByText('取消', dialog);
    if (cancel) click(cancel);
    await sleep(500);
    return { ok: urls.length > 0 || images.length === 0, urls, errors };
  }

  function writeEditor(editor, html) {
    editor.focus();
    editor.innerHTML = html;
    for (const t of ['input', 'keyup', 'change']) editor.dispatchEvent(new Event(t, { bubbles: true }));
    editor.dispatchEvent(new FocusEvent('blur'));
  }

  // 条件要连续保持 ms 毫秒才算数：切换模式后京麦会异步重建编辑器、用旧内容覆盖表单值
  async function holdsFor(check, ms, interval = 200) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!check()) return false;
      await sleep(interval);
    }
    return !!check();
  }

  // 代码编辑器的内容由页面同步到表单值 productDesc.notes，保存时提交的是表单值。
  // 切换模式后页面可能还在重建编辑器，刚写进去的内容会被覆盖：每次重试都重新找编辑器，
  // 写进去后还要保持一段时间不被改掉；编辑器始终同步不过去时直接写表单值
  async function setDescriptionHtml(html, { attempts = 3, syncMs = 4000, settleMs = 1500 } = {}) {
    if (!(await switchDescMode('代码编辑'))) return { ok: false, error: '无法切换到代码编辑模式' };
    const api = B.getFApi();
    const firstSrc = ((html.match(/src="([^"]+)"/) || [])[1] || '').replace(/&amp;/g, '&');
    const notes = () => (api.getValue('productDesc') || {}).notes || '';
    const written = () => notes() !== '' && (!firstSrc || notes().includes(firstSrc));
    let editorLength = 0;
    for (let i = 0; i < attempts; i += 1) {
      const editor = await waitFor(() => qsa('.w-e-text').find(visible), { timeout: 5000 });
      if (!editor) return { ok: false, error: '找不到详情编辑器' };
      writeEditor(editor, html);
      editorLength = editor.innerHTML.length;
      if ((await waitFor(written, { timeout: syncMs })) && (await holdsFor(written, settleMs))) return { ok: true, length: notes().length };
    }
    api.setValue('productDesc', Object.assign({}, api.getValue('productDesc'), { notes: html }));
    if (await holdsFor(written, settleMs)) return { ok: true, length: notes().length, direct: true };
    return { ok: false, error: `商品详情没有写进表单（编辑器 ${editorLength} 字符，表单 ${notes().length} 字符）` };
  }

  // ---------- 提交动作 ----------
  // auto：改价时用，编辑页上按顺序找“提交/保存”类按钮，不点会改变上下架状态的按钮
  const ACTION_BUTTONS = {
    draft: ['保存草稿'],
    submit_off: ['提交暂不上架'],
    submit_on: ['提交并上架', '提交审核并上架'],
    auto: ['提交', '保存', '提交审核', '提交修改', '保存修改', '确认修改'],
  };
  // 保存/提交成功后京麦弹出“保存成功 … 我知道了”，需要点掉才算结束
  const SUCCESS_POPUP_RE = /保存成功|提交成功|发布成功|操作成功/;
  const ACK_LABELS = ['我知道了', '知道了', '确定', '关闭'];

  function ackButton(box) {
    for (const label of ACK_LABELS) {
      const btn = buttonByText(label, box);
      if (btn) return btn;
    }
    return null;
  }

  const idField = (text, name) => (String(text || '').match(new RegExp(`"${name}"\\s*:\\s*"?(\\d{6,20})`)) || [])[1] || '';
  // 发布页的提交接口（saveproduct / saveProductNew）：成功时返回新商品的 productId，也就是店铺商品编号（wareId）
  const SAVE_API_RE = /saveproduct/i;
  // 返回了编号但同时标着失败（success:false、4xx/5xx 错误码）不算提交成功
  const FAILED_BODY_RE = /"success"\s*:\s*false|"code"\s*:\s*"?[45]\d\d\b/;

  // 提交接口的返回里带店铺商品编号：点击期间临时拦截 XHR/fetch 的返回，记下其中的编号；
  // productId 只认提交接口的（其他接口里的 productId 可能是标准产品编号）。
  // “提交并上架”成功后京麦不弹提示，100ms 后直接整页跳到成功页，所以提交接口返回编号就算提交成功（saved）。
  // 结束后 restore() 恢复原来的 XHR/fetch，不长期改动页面
  function installWareIdCapture() {
    const captured = [];
    const saved = [];
    const restores = [];
    const record = (text, url) => {
      const isSave = SAVE_API_RE.test(String(url || ''));
      const id = idField(text, 'wareId') || (isSave ? idField(text, 'productId') : '');
      if (id) captured.push({ id, at: Date.now() });
      if (id && isSave && !FAILED_BODY_RE.test(String(text))) saved.push({ id, at: Date.now() });
    };
    if (typeof XMLHttpRequest !== 'undefined') {
      const origSend = XMLHttpRequest.prototype.send;
      restores.push(() => (XMLHttpRequest.prototype.send = origSend));
      XMLHttpRequest.prototype.send = function send(body) {
        this.addEventListener('load', () => {
          try {
            record(this.responseText, this.responseURL);
          } catch {
            /* 非文本响应忽略 */
          }
        });
        return origSend.call(this, body);
      };
    }
    if (typeof window.fetch === 'function') {
      const origFetch = window.fetch;
      restores.push(() => (window.fetch = origFetch));
      window.fetch = function fetchWithCapture(...args) {
        return origFetch.apply(window, args).then((res) => {
          if (/json|text/.test(res.headers.get('content-type') || '')) res.clone().text().then((t) => record(t, res.url), () => undefined);
          return res;
        });
      };
    }
    return { captured, saved, restore: () => [...restores].reverse().forEach((fn) => fn()) };
  }

  async function runAction(action, opts) {
    const capture = installWareIdCapture();
    try {
      return await clickAndWatch(action, opts, capture);
    } finally {
      capture.restore();
    }
  }

  // 只认点击之后新出现的提示：页面上可能还留着“批量设置成功”之类的提示，
  // 之前把它当成保存结果，误报成功并立刻关掉标签页，保存请求根本没发出去
  async function clickAndWatch(action, { timeoutMs = 20000 } = {}, capture = { captured: [], saved: [] }) {
    const labels = ACTION_BUTTONS[action];
    if (!labels) return { ok: true, skipped: true };
    const btn = labels.map((l) => buttonByText(l)).find(Boolean);
    if (!btn) return { ok: false, error: `找不到“${labels.join('”或“')}”按钮` };
    const label = textOf(btn);
    if (btn.classList.contains('is-disabled') || btn.disabled) {
      const st = B.status();
      return { ok: false, error: `“${label}”不可用：${st.publishDisabledMsg || '请检查页面提示'}` };
    }
    const startUrl = location.href;
    const preexisting = new Set(messages());
    const seen = new Set();
    const clickedAt = Date.now();
    click(btn);
    const end = Date.now() + timeoutMs;
    let confirmText = '';
    let popupSuccess = false;
    let submitted = false;
    while (Date.now() < end) {
      // 页面马上会跳走，脚本随之结束：先把结果带回去
      // 保存草稿不跳转、草稿也没有店铺编号：只按弹窗判断
      if (action !== 'draft' && capture.saved.some((c) => c.at >= clickedAt)) {
        submitted = true;
        break;
      }
      messages().filter((m) => !preexisting.has(m)).forEach((m) => seen.add(m));
      const box = visibleDialogs().find(
        (d) => d.classList.contains('jd-message-box') || /提示|确认/.test(textOf(d).slice(0, 20)) || SUCCESS_POPUP_RE.test(textOf(d)),
      );
      if (box && SUCCESS_POPUP_RE.test(textOf(box))) {
        seen.add(textOf(box).slice(0, 200));
        const ack = ackButton(box);
        if (ack) click(ack);
        popupSuccess = true;
        break;
      }
      if (box && !confirmText) {
        confirmText = textOf(box).slice(0, 200);
        if (action === 'draft') {
          const ok = buttonByText('确定', box);
          if (ok) click(ok);
        } else break; // 提交前的确认框交给人工判断
      }
      if (location.href !== startUrl) break;
      if ([...seen].some((m) => SUCCESS_POPUP_RE.test(m) || /失败|错误|请/.test(m))) break;
      await sleep(100);
    }
    const msgs = [...seen];
    if (submitted && !msgs.some((m) => SUCCESS_POPUP_RE.test(m))) msgs.push('商品提交成功');
    const errors = B.collectErrors();
    const success = submitted || popupSuccess || msgs.some((m) => SUCCESS_POPUP_RE.test(m)) || (location.href !== startUrl && !/popPublish/.test(location.href));
    if (!success && !msgs.length && !errors.length) msgs.push(`点击“${label}”后没有看到保存结果`);
    const draftIds = new Set(action === 'draft' ? capture.saved.map((c) => c.id) : []);
    const wareIds = capture.captured.filter((c) => c.at >= clickedAt && !draftIds.has(c.id)).map((c) => c.id);
    return {
      ok: submitted || popupSuccess || (success && errors.length === 0),
      messages: msgs,
      errors,
      confirmText: popupSuccess ? '' : confirmText,
      url: location.href,
      wareIds,
    };
  }

  Object.assign(B, {
    __media: true,
    uploadMainImages,
    setSaleValues,
    setSkuRows,
    setSkuPrices,
    readSkuPrices,
    fillSkuAttrDrawers,
    readSkuAttrState,
    checkSkuRows,
    switchDescMode,
    drawerFields,
    waitSkuTableStable,
    uploadDetailImages,
    setDescriptionHtml,
    runAction,
    skuRowCount: () => skuRows().length,
  });
})();
