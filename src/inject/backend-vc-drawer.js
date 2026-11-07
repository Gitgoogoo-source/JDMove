// VC 发布页 SKU 表的两个抽屉：规格（按类目拆成结构化字段）、SKU属性。依赖 backend-vc.js 先注入。
// 两个抽屉的字段都是 .shop-dynamic-component（标题 .shop-dynamic-component-title，带 is-required-star 为必填），
// 控件按 class 区分：
//   .sale-number-units        数字 + 单位下拉（层数 3 层）
//   .sale-base-group          只读框，点开是弹层，里面再放几组数字 + 单位（规格：单包抽数 × 包数）
//   .sale-custom-notes        文本（产品描述）
//   .sale-structured-template 可输入可选择，选项是一排按钮（包装形式）
//   .jd-select-v2             新版下拉，选项 li.jd-select-dropdown__option-item
//   .jd-select                旧版下拉，选项 li.jd-select-dropdown__item
//   只读输入框                点开是数字弹层（纸张尺寸：长、宽），弹层里有“确定”
//   普通输入框                后面可能带单位（包数 [包]），只填数字
(() => {
  const NS = window.__JDMOVE__;
  if (!NS || !NS.backend || !NS.backend.__vc || NS.backend.__vcDrawer) return;
  const B = NS.backend;
  const { sleep, qsa, visible, textOf, norm, waitFor, setNativeValue, click, buttonByText } = B.util;
  const { commitInput } = B.mediaUtil;
  const { vcSkuRows, cellOf } = B.vcUtil;

  const NUMBER_RE = /\d+(?:\.\d+)?/;
  const firstNumber = (v) => (String(v ?? '').match(NUMBER_RE) || [''])[0];
  const allNumbers = (v) => String(v ?? '').match(/\d+(?:\.\d+)?/g) || [];
  const unitOfValue = (v) => String(v ?? '').replace(/[\d.\s]+/g, '').trim();
  const editable = (root) => qsa('input.jd-input__inner, textarea', root).find((i) => !i.readOnly && !i.disabled) || null;

  function plannedValue(label, values) {
    const want = norm(label);
    const keys = Object.keys(values || {});
    const exact = keys.find((k) => norm(k) === want);
    if (exact) return values[exact];
    const near = keys.find((k) => norm(k).length >= 2 && (want.includes(norm(k)) || norm(k).includes(want)));
    return near ? values[near] : null;
  }

  function fieldsOf(drawer) {
    return qsa('.shop-dynamic-component', drawer)
      .filter((c) => !(c.parentElement && c.parentElement.closest('.shop-dynamic-component')))
      .map((root) => {
        const t = root.querySelector('.shop-dynamic-component-title');
        const label = t ? textOf(t).replace(/[*＊]/g, '').replace(/重要$/, '').trim() : '';
        return { root, label, required: !!(t && t.classList.contains('is-required-star')) };
      })
      .filter((f) => f.label);
  }

  const CLASSIC_OPTION = '.jd-select-dropdown__item';
  const V2_OPTION = 'li.jd-select-dropdown__option-item';
  const visibleOptions = (sel) => qsa(sel).filter(visible);
  const pickText = (els, value) => {
    const want = norm(value);
    return els.find((el) => norm(textOf(el)) === want) || els.find((el) => want && (norm(textOf(el)).includes(want) || want.includes(norm(textOf(el))))) || null;
  };

  function hoverClick(el) {
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    click(el);
  }

  /** 等上一个下拉收起，避免把它的选项当成这一个的 */
  const optionsClosed = (sel) => waitFor(() => !visibleOptions(sel).length, { timeout: 1500 });

  /**
   * 旧版下拉（单位）：点里面的输入框才会展开（点外层不展开，所以不用 openSelect）
   * @returns {Promise<string[]>} 展开后的选项文字；展不开时为空
   */
  async function openClassic(selectRoot) {
    const input = selectRoot.querySelector('input');
    if (!input) return [];
    await optionsClosed(CLASSIC_OPTION);
    hoverClick(input);
    const items = await waitFor(() => {
      const list = visibleOptions(CLASSIC_OPTION);
      return list.length ? list : null;
    }, { timeout: 3000 });
    return items ? items.map(textOf) : [];
  }

  /** 收起旧版下拉：再点一次输入框（点页面空白处可能把抽屉或弹层一起关掉） */
  async function closeClassic(selectRoot) {
    if (!visibleOptions(CLASSIC_OPTION).length) return;
    const input = selectRoot.querySelector('input');
    if (input) click(input);
    await optionsClosed(CLASSIC_OPTION);
  }

  /** 旧版下拉：选文字等于 wanted 中第一个有的选项；返回选中的文字 */
  async function pickClassic(selectRoot, wanted) {
    const current = (selectRoot.querySelector('input') || {}).value || '';
    const already = wanted.find((w) => w === current);
    if (already) return already;
    const labels = await openClassic(selectRoot);
    const label = wanted.find((w) => labels.includes(w));
    const hit = label && visibleOptions(CLASSIC_OPTION).find((li) => textOf(li) === label);
    if (hit) click(hit);
    else await closeClassic(selectRoot);
    await optionsClosed(CLASSIC_OPTION);
    return hit ? label : null;
  }

  /** 旧版下拉的全部选项文字（展开再收起） */
  async function classicOptions(selectRoot) {
    const labels = await openClassic(selectRoot);
    await closeClassic(selectRoot);
    return labels;
  }

  /** 数字 + 单位：值“3层”直接拆；没有值时按单位下拉的选项去规格里找同单位的数量 */
  async function fillNumberUnit(box, value, ctx) {
    const input = editable(box);
    const select = box.querySelector('.jd-select');
    if (!input) return false;
    let num = firstNumber(value);
    let units = value ? [unitOfValue(value)].filter(Boolean) : [];
    if (!num && select) {
      const opts = await classicOptions(select);
      const unit = opts.find((u) => ctx.units[u] != null);
      if (unit) {
        num = ctx.units[unit];
        units = [unit];
      }
    }
    if (!num) return false;
    commitInput(input, num);
    await sleep(150);
    const unit = select && units.length ? await pickClassic(select, units) : 'none';
    return input.value === num && !!unit;
  }

  /** 弹层里的几组数字 + 单位（规格：单包抽数 × 包数）；全部填完弹层自动应用 */
  async function fillGroup(root, value, ctx) {
    const trigger = root.querySelector('.sale-base-group input');
    if (!trigger) return false;
    click(trigger);
    const pop = await waitFor(() => qsa('.jd-popper').find((p) => visible(p) && p.querySelector('.sale-number-units')), { timeout: 3000 });
    if (!pop) return false;
    for (const box of qsa('.sale-number-units', pop)) {
      const inner = editable(box);
      const own = plannedValue((inner && inner.placeholder) || '', ctx.values);
      await fillNumberUnit(box, own, ctx);
    }
    await sleep(300);
    click(root.querySelector('.shop-dynamic-component-title') || root);
    await sleep(300);
    return !!trigger.value;
  }

  async function fillText(root, value) {
    const input = editable(root);
    if (!input || !value) return false;
    commitInput(input, String(value));
    await sleep(100);
    return input.value === String(value);
  }

  /** 可输入可选择（包装形式）：只选页面给的选项，匹配不上不乱填 */
  async function fillTemplate(root, value) {
    const input = root.querySelector('.sale-structured-template input');
    if (!input || !value) return false;
    click(input);
    const pop = await waitFor(() => qsa('.jd-popper').find((p) => visible(p) && pickText(qsa('button, span, div', p).filter((e) => !e.children.length), value)), { timeout: 2000 });
    const hit = pop && pickText(qsa('button, span, div', pop).filter((e) => !e.children.length && textOf(e)), value);
    if (hit) click(hit.closest('button') || hit);
    else document.body.click();
    await sleep(200);
    return !!hit && !!input.value;
  }

  /**
   * 新版下拉：等上一个下拉收起后再展开（否则会读到上一个的选项），直接点选项。
   * 不在框里输入筛选：输入会触发 change，下拉失焦时把已选的值清掉。没有匹配的选项时按 Esc 收起
   */
  async function fillSelectV2(root, value) {
    if (!value) return false;
    const box = root.querySelector('.jd-select-v2');
    const combo = box.querySelector('input.jd-select-v2__combobox-input');
    await optionsClosed(V2_OPTION);
    click(box.querySelector('.jd-select-v2__wrapper') || box);
    const items = await waitFor(() => {
      const list = visibleOptions(V2_OPTION);
      return list.length ? list : null;
    }, { timeout: 3000 });
    const hit = items && pickText(items, value);
    if (hit) click(hit);
    else if (combo) combo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await optionsClosed(V2_OPTION);
    return !!hit;
  }

  /** 只读框点开是数字弹层（纸张尺寸：长、宽），按顺序填文本里的数字，再点弹层里的“确定” */
  async function fillNumberPopover(root, value) {
    const nums = allNumbers(value);
    const trigger = qsa('input', root).find((i) => i.readOnly);
    if (!trigger || !nums.length) return false;
    click(trigger);
    const pop = await waitFor(() => qsa('.jd-popper').find((p) => visible(p) && buttonByText('确定', p) && editable(p)), { timeout: 3000 });
    if (!pop) return false;
    const inputs = qsa('input.jd-input__inner', pop).filter((i) => !i.readOnly && visible(i));
    inputs.forEach((input, i) => nums[i] != null && commitInput(input, nums[i]));
    await sleep(150);
    click(buttonByText('确定', pop));
    await sleep(300);
    return !!trigger.value;
  }

  async function fillPlain(root, value, ctx) {
    const input = editable(root);
    if (!input) return false;
    const append = root.querySelector('.jd-input-group__append');
    const unit = append ? textOf(append) : '';
    const raw = value != null ? value : unit ? ctx.units[unit] : null;
    if (raw == null) return false;
    const text = unit ? firstNumber(raw) : String(raw);
    if (!text) return false;
    commitInput(input, text);
    await sleep(100);
    return input.value === text;
  }

  /** 字段本身是旧版下拉：按文字（可模糊）选 */
  async function fillClassic(root, value) {
    const select = root.querySelector('.jd-select');
    if (!value || !select) return false;
    await openClassic(select);
    const hit = pickText(visibleOptions(CLASSIC_OPTION), value);
    if (hit) click(hit);
    else await closeClassic(select);
    await optionsClosed(CLASSIC_OPTION);
    return !!hit;
  }

  async function fillField({ root, label }, ctx) {
    const value = plannedValue(label, ctx.values);
    if (root.querySelector('.sale-base-group')) return fillGroup(root, value, ctx);
    if (root.querySelector('.sale-number-units')) return fillNumberUnit(root.querySelector('.sale-number-units'), value, ctx);
    if (root.querySelector('.sale-custom-notes')) return fillText(root, value != null ? value : ctx.desc);
    if (root.querySelector('.sale-structured-template')) return fillTemplate(root, value);
    if (root.querySelector('.jd-select-v2')) return fillSelectV2(root, value);
    if (root.querySelector('.jd-select')) return fillClassic(root, value);
    if (qsa('input', root).some((i) => i.readOnly)) return fillNumberPopover(root, value);
    return fillPlain(root, value, ctx);
  }

  const DRAWER_CONFIRM_TRIES = 3;

  async function confirm(drawer) {
    for (let i = 0; i < DRAWER_CONFIRM_TRIES; i += 1) {
      await sleep(400);
      const ok = buttonByText('确定', drawer);
      if (!ok) break;
      click(ok);
      if (await waitFor(() => !visible(drawer), { timeout: 2500 })) return { confirmed: true, errors: [] };
    }
    const errors = qsa('.jd-form-item__error, .shop-dynamic-component-error, [class*="error"]', drawer).filter(visible).map(textOf).filter(Boolean);
    const close = buttonByText('关闭', drawer) || buttonByText('取消', drawer);
    if (close) click(close);
    await sleep(400);
    return { confirmed: false, errors: [...new Set(errors)] };
  }

  /**
   * 打开第 rowIndex 行某一列的抽屉，逐个字段填写后点“确定”
   * @param {'SaleDrawer'|'ShopSkuAttributeCommon'} column
   * @param {{rowIndex?: number, values?: Record<string, string>, units?: Record<string, string>, desc?: string}} plan
   */
  async function fillRowDrawer(column, { rowIndex = 0, values = {}, units = {}, desc = '' }) {
    const tr = vcSkuRows()[rowIndex];
    const trigger = tr && cellOf(tr, column);
    if (!trigger) return { opened: false, confirmed: false, filled: [], missing: [], errors: ['找不到单元格'] };
    const before = new Set(qsa('.jd-drawer').filter(visible));
    trigger.scrollIntoView({ block: 'center' });
    click(trigger);
    const drawer = await waitFor(() => qsa('.jd-drawer').find((d) => visible(d) && !before.has(d)), { timeout: 5000 });
    if (!drawer) return { opened: false, confirmed: false, filled: [], missing: [], errors: ['抽屉没有打开'] };
    await sleep(500);
    const ctx = { values, units, desc };
    const filled = [];
    const missing = [];
    for (const field of fieldsOf(drawer)) {
      let done = false;
      try {
        done = await fillField(field, ctx);
      } catch {
        done = false;
      }
      if (done) filled.push(field.label);
      else if (field.required && !qsa('input', field.root).some((i) => i.value)) missing.push(field.label);
    }
    const result = await confirm(drawer);
    return { opened: true, ...result, filled, missing };
  }

  Object.assign(B, {
    __vcDrawer: true,
    /** 规格（结构化）：values 为源参数，units 为规格里按单位拆出的数量，desc 为规格的描述（【王牌囤货装】） */
    vcFillSpec: (plan) => fillRowDrawer('SaleDrawer', plan),
    /** SKU属性：values 为源参数/属性默认值/属性覆盖，units 同上（包数这类只带单位的输入框用） */
    vcFillSkuAttrs: (plan) => fillRowDrawer('ShopSkuAttributeCommon', plan),
  });
})();
