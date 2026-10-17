// 发布页：图片上传、销售属性、SKU 表、商品详情、提交动作（MAIN world）。
// 依赖 backend-core.js 先注入。
(() => {
  const NS = window.__JDMOVE__;
  if (!NS || !NS.backend || NS.backend.__media) return;
  const B = NS.backend;
  const { sleep, qsa, visible, textOf, norm, waitFor, setNativeValue, pressEnter, click, openSelect, buttonByText, visibleDialogs, messages } = B.util;

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
  async function addSaleValue(dimName, value) {
    const placeholder = `请设置${dimName}`;
    const empty = qsa('input').filter((i) => i.placeholder === placeholder && !i.value && visible(i)).pop();
    if (!empty) return false;
    click(empty);
    await sleep(300);
    setNativeValue(empty, value);
    // 回车只有在输入框真正获得焦点时才会提交（点击可能弹出预设值浮层抢走焦点）
    empty.focus();
    await sleep(100);
    pressEnter(empty);
    await sleep(400);
    empty.blur();
    await sleep(300);
    return empty.value === value;
  }

  async function setSaleValues(dims) {
    const failed = [];
    for (const dim of dims) {
      for (const value of dim.values) {
        const existing = qsa('input').some((i) => i.placeholder === `请设置${dim.name}` && i.value === value);
        if (existing) continue;
        if (!(await addSaleValue(dim.name, value))) failed.push(`${dim.name}:${value}`);
      }
    }
    const expected = dims.reduce((n, d) => n * Math.max(1, d.values.length), 1);
    const rows = await waitFor(() => (skuRows().length === expected ? expected : null), { timeout: 5000 });
    if (!rows) failed.push(`SKU 行数 ${skuRows().length}，预期 ${expected}`);
    return { ok: failed.length === 0, failed, rows: skuRows().length };
  }

  // ---------- SKU 表 ----------
  function skuRows() {
    return qsa('tr').filter((tr) => visible(tr) && tr.querySelectorAll('input[placeholder="请输入"]').length >= 2 && tr.querySelector('.jd-switch'));
  }

  async function batchApply(price, stock) {
    const priceInput = qsa('input').find((i) => i.placeholder === '京东价(元)' && visible(i));
    const stockInput = qsa('input').find((i) => i.placeholder === '库存' && visible(i));
    const btn = buttonByText('批量应用');
    if (!priceInput || !stockInput || !btn) return false;
    setNativeValue(priceInput, String(price));
    setNativeValue(stockInput, String(stock));
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
      if (row.enabled && String(row.price) !== priceInput.value) setNativeValue(priceInput, String(row.price));
      if (String(row.stock) !== stockInput.value) setNativeValue(stockInput, String(row.stock));
      priceInput.dispatchEvent(new Event('blur'));
      stockInput.dispatchEvent(new Event('blur'));
      const sw = tr.querySelector('.jd-switch');
      const on = sw.classList.contains('is-checked');
      if (on !== row.enabled) click(sw);
    });
    await sleep(500);
    return { ok: issues.length === 0, issues, rows: domRows.length };
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

  async function fillSkuAttrDrawers(valueMap) {
    const results = [];
    const count = skuRows().length;
    for (let idx = 0; idx < count; idx += 1) {
      const tr = skuRows()[idx];
      const trigger = tr && qsa('input', tr).find((i) => i.placeholder === 'SKU属性' || i.value === 'SKU属性');
      if (!trigger) continue;
      tr.scrollIntoView({ block: 'center' });
      click(trigger);
      const drawer = await waitFor(() => qsa('.jd-drawer').find((d) => visible(d) && /SKU属性/.test(textOf(d))), { timeout: 5000 });
      if (!drawer) {
        results.push({ row: idx, ok: false, error: '未打开SKU属性面板' });
        continue;
      }
      const missing = [];
      for (const fi of qsa('.jd-form-item', drawer)) {
        const label = textOf(fi.querySelector('.jd-form-item__label')).replace(/[*＊]/g, '');
        const required = fi.classList.contains('is-required') || /\*/.test(textOf(fi.querySelector('.jd-form-item__label')));
        const value = matchLabelValue(label, valueMap);
        const input = fi.querySelector('input.jd-input__inner:not([readonly]), textarea');
        let done = false;
        if (value != null && input && !input.value) {
          setNativeValue(input, String(value));
          done = true;
        } else if (value != null && fi.querySelector('.jd-select')) {
          done = await chooseSelectOption(fi, value);
        } else if (input && input.value) done = true;
        if (!done && required) missing.push(label);
      }
      const ok = buttonByText('确定', drawer);
      if (ok) click(ok);
      const closed = await waitFor(() => !visible(drawer), { timeout: 2500 });
      if (!closed) {
        const cancel = buttonByText('取消', drawer);
        if (cancel) click(cancel);
        await sleep(500);
      }
      results.push({ row: idx, ok: !!closed && missing.length === 0, missing });
    }
    return { ok: results.every((r) => r.ok), results };
  }

  // ---------- 商品详情 ----------
  function descriptionSection() {
    return qsa('.shop-editor_content-right, [class*="shop-editor"]').find(visible) || document;
  }

  async function switchDescMode(label) {
    const radio = qsa('label.jd-radio', descriptionSection()).find((l) => textOf(l) === label) ||
      qsa('label.jd-radio').find((l) => textOf(l) === label && visible(l));
    if (!radio) return false;
    if (radio.classList.contains('is-checked')) return true;
    click(radio);
    const confirm = await waitFor(() => {
      const box = visibleDialogs().find((d) => /切换/.test(textOf(d)));
      return box ? buttonByText('确定', box) : null;
    }, { timeout: 2000 });
    if (confirm) click(confirm);
    return !!(await waitFor(() => radio.classList.contains('is-checked'), { timeout: 3000 }));
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

  async function setDescriptionHtml(html) {
    if (!(await switchDescMode('代码编辑'))) return { ok: false, error: '无法切换到代码编辑模式' };
    const editor = await waitFor(() => qsa('.w-e-text').find(visible), { timeout: 5000 });
    if (!editor) return { ok: false, error: '找不到详情编辑器' };
    editor.focus();
    editor.innerHTML = html;
    for (const t of ['input', 'keyup', 'change']) editor.dispatchEvent(new Event(t, { bubbles: true }));
    editor.dispatchEvent(new FocusEvent('blur'));
    const firstSrc = (html.match(/src="([^"]+)"/) || [])[1] || '';
    const notes = await waitFor(() => {
      const d = B.getFApi().getValue('productDesc');
      return d && d.notes && (!firstSrc || d.notes.includes(firstSrc.replace(/&amp;/g, '&'))) ? d.notes : null;
    }, { timeout: 4000 });
    return { ok: !!notes, length: notes ? notes.length : 0 };
  }

  // ---------- 提交动作 ----------
  const ACTION_BUTTON = { draft: '保存草稿', submit_off: '提交暂不上架', submit_on: '提交并上架' };

  async function runAction(action) {
    const label = ACTION_BUTTON[action];
    if (!label) return { ok: true, skipped: true };
    const btn = buttonByText(label);
    if (!btn) return { ok: false, error: `找不到“${label}”按钮` };
    if (btn.classList.contains('is-disabled') || btn.disabled) {
      const st = B.status();
      return { ok: false, error: `“${label}”不可用：${st.publishDisabledMsg || '请检查页面提示'}` };
    }
    const startUrl = location.href;
    const seen = new Set();
    click(btn);
    const end = Date.now() + 20000;
    let confirmText = '';
    while (Date.now() < end) {
      messages().forEach((m) => seen.add(m));
      const box = visibleDialogs().find((d) => d.classList.contains('jd-message-box') || /提示|确认/.test(textOf(d).slice(0, 20)));
      if (box && !confirmText) {
        confirmText = textOf(box).slice(0, 200);
        if (action === 'draft') {
          const ok = buttonByText('确定', box);
          if (ok) click(ok);
        } else break; // 提交前的确认框交给人工判断
      }
      if (location.href !== startUrl) break;
      if ([...seen].some((m) => /成功|失败|错误|请/.test(m))) break;
      await sleep(300);
    }
    const msgs = [...seen];
    const errors = B.collectErrors();
    const success = msgs.some((m) => /成功/.test(m)) || (location.href !== startUrl && !/popPublish/.test(location.href));
    return { ok: success && errors.length === 0, messages: msgs, errors, confirmText, url: location.href };
  }

  Object.assign(B, {
    __media: true,
    uploadMainImages,
    setSaleValues,
    setSkuRows,
    fillSkuAttrDrawers,
    uploadDetailImages,
    setDescriptionHtml,
    runAction,
    skuRowCount: () => skuRows().length,
  });
})();
