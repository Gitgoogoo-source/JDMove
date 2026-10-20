// 批量改价弹窗：逐个商品填写新售价（可一键按京东今日价或统一价格填入）和店铺商品编号
import { h, openDialog } from './dom.js';
import { priceStatus, priceFromJd, deriveEditUrlTemplate, normalizeWareId } from '../shared/price-watch.js';
import { REPRICE_ACTIONS, EDIT_URL_RULE } from '../shared/settings.js';

export const EDIT_URL_HINT =
  '在京麦“商品管理”里点任意一个商品的“编辑”，把打开的页面地址复制到这里。插件会把地址里的商品编号换成每个商品自己的编号；也可以直接填写带 {wareId} 的地址模板。';

/** 编辑页地址输入框下方的实时说明：识别到的商品编号，或者为什么不能用 */
export function editUrlPreview(input) {
  const note = h('small', { class: 'url-preview' });
  const update = () => {
    const raw = input.value.trim();
    const t = deriveEditUrlTemplate(raw);
    note.classList.toggle('bad', Boolean(raw) && !t);
    note.textContent = !raw
      ? ''
      : !t
        ? `无法使用：${EDIT_URL_RULE}`
        : t.sampleId
          ? `识别到商品编号 ${t.sampleId}，每个商品会打开：${t.template}`
          : `每个商品会打开：${t.template}`;
  };
  input.addEventListener('input', update);
  update();
  return note;
}

const cents = (v) => Math.round(Number(v) * 100) / 100;
const numberInput = (attrs) => h('input', { type: 'number', step: '0.01', ...attrs });

function jdCell(item, st) {
  const check = item.priceCheck;
  if (check?.price > 0) return h('td', { class: st.alert ? 'alert-text' : '' }, `¥${check.price}`, check.label ? h('div', { class: 'sub' }, check.label) : null);
  return h('td', { class: 'sub' }, check?.error ? '获取失败' : '未检查');
}

/** 一行：需要提醒的商品默认填入“京东今日价 + 预警线”（预警线为 0 时即与京东一致） */
function planRow(item, settings, margin) {
  const st = priceStatus(item, settings);
  const label = `SKU ${item.skuId}`;
  const suggested = st.alert ? priceFromJd(item, margin) : null;
  const price = numberInput({ min: '0.01', value: suggested ?? '', placeholder: '不改', 'aria-label': `${label} 新售价` });
  const wareId = h('input', { value: item.shopWareId ?? '', placeholder: '店铺商品编号', pattern: '\\d{4,20}', inputmode: 'numeric', 'aria-label': `${label} 店铺商品编号` });
  const tr = h(
    'tr',
    { class: st.alert ? 'price-alert' : '' },
    h('td', {}, h('div', { class: 'title clamp' }, item.edits?.title || item.product?.title || label), h('div', { class: 'sub' }, label)),
    h('td', {}, st.sale > 0 ? `¥${st.sale}` : '—'),
    jdCell(item, st),
    h('td', {}, price),
    h('td', {}, wareId),
  );
  return { item, tr, price, wareId };
}

function quickFill(rows, margin) {
  const add = numberInput({ value: String(margin), class: 'narrow', 'aria-label': '在京东今日价上加价（元）' });
  const fixed = numberInput({ min: '0.01', class: 'narrow', placeholder: '价格', 'aria-label': '统一售价（元）' });
  const fillJd = () => {
    for (const r of rows) {
      const p = priceFromJd(r.item, Number(add.value));
      if (p) r.price.value = String(p);
    }
  };
  const fillFixed = () => {
    if (Number(fixed.value) > 0) rows.forEach((r) => (r.price.value = String(cents(fixed.value))));
  };
  return h(
    'div',
    { class: 'quick-fill' },
    h('span', {}, '按京东今日价 +'),
    add,
    h('span', {}, '元'),
    h('button', { type: 'button', onclick: fillJd }, '填入'),
    h('span', { class: 'sep' }),
    h('span', {}, '统一改为'),
    fixed,
    h('span', {}, '元'),
    h('button', { type: 'button', onclick: fillFixed }, '填入'),
    h('span', { class: 'sep' }),
    h('button', { type: 'button', onclick: () => rows.forEach((r) => (r.price.value = '')) }, '清空'),
  );
}

/** 提交前校验：编辑页地址、至少一个新售价、填了新售价的行要有店铺商品编号；不通过时阻止提交并提示 */
function validate(urlInput, rows) {
  [urlInput, ...rows.flatMap((r) => [r.price, r.wareId])].forEach((el) => el.setCustomValidity(''));
  if (!deriveEditUrlTemplate(urlInput.value)) urlInput.setCustomValidity(`请粘贴商品编辑页地址：${EDIT_URL_RULE}`);
  const planned = rows.filter((r) => Number(r.price.value) > 0);
  if (!planned.length && rows.length) rows[0].price.setCustomValidity('请至少给一个商品填写新售价');
  for (const r of planned) {
    if (!normalizeWareId(r.wareId.value)) r.wareId.setCustomValidity('请填写店铺商品编号，或清空这一行的新售价');
  }
}

/**
 * @param {object[]} items 要改价的已发布商品
 * @param {object} settings
 * @returns {Promise<{template: string, verify: boolean, rows: {id: string, price: number|null, wareId: string}[]} | null>}
 */
export async function openRepriceDialog(items, settings) {
  const margin = settings.priceWatch.alertMargin;
  const rows = items.map((item) => planRow(item, settings, margin));
  const urlInput = h('input', { value: settings.priceWatch.editUrlTemplate, placeholder: 'https://… 商品编辑页地址' });
  const verify = h('input', { type: 'checkbox', checked: true });
  const unchecked = items.filter((i) => !(i.priceCheck?.price > 0)).length;
  const okBtn = h('button', { value: 'ok', class: 'primary' }, '开始改价');
  okBtn.addEventListener('click', () => validate(urlInput, rows));
  const dialog = h(
    'dialog',
    { class: 'wide' },
    h(
      'form',
      { method: 'dialog' },
      h('div', { class: 'dlg-head' }, `批量改价（${items.length} 个商品）`),
      h(
        'div',
        { class: 'dlg-body' },
        h('label', { class: 'field' }, h('span', {}, '商品编辑页地址'), urlInput, editUrlPreview(urlInput), h('small', {}, EDIT_URL_HINT)),
        quickFill(rows, margin),
        unchecked ? h('p', { class: 'muted' }, `其中 ${unchecked} 个商品还没有京东今日价，按今日价填入时会跳过它们（可先“检查京东今日价”）。`) : null,
        h(
          'table',
          { class: 'items plan' },
          h('thead', {}, h('tr', {}, ...['商品', '当前售价', '京东今日价', '新售价', '店铺商品编号'].map((t) => h('th', {}, t)))),
          h('tbody', {}, ...rows.map((r) => r.tr)),
        ),
        h(
          'p',
          { class: 'muted' },
          `插件会依次打开每个商品的编辑页，把所有已启用规格的京东价改成新售价，然后：${REPRICE_ACTIONS[settings.priceWatch.repriceAction]}（可在设置中修改）。新售价留空的商品不改。`,
        ),
        h(
          'label',
          { class: 'check' },
          verify,
          '核对原价：编辑页上的京东价与记录的当前售价一致才改（防止店铺商品编号填错改到别的商品；在后台手动改过价的商品可取消勾选）',
        ),
      ),
      h('div', { class: 'dlg-foot' }, h('button', { value: 'cancel', formnovalidate: true }, '取消'), okBtn),
    ),
  );
  // 在输入框里按回车不提交：避免价格没填完就开始改价（默认按钮是“取消”，回车还会丢掉填好的内容）
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) e.preventDefault();
  });
  if ((await openDialog(dialog)) !== 'ok') return null;
  return {
    template: deriveEditUrlTemplate(urlInput.value)?.template ?? '',
    verify: verify.checked,
    rows: rows.map((r) => ({
      id: r.item.id,
      price: Number(r.price.value) > 0 ? cents(r.price.value) : null,
      wareId: normalizeWareId(r.wareId.value),
    })),
  };
}
