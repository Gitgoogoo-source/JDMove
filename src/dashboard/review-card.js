// 发布前检查弹窗里的一个商品：头部（勾选发布、主图、标题、上架模板下拉、状态），展开后是按模板列出的字段、图片、属性。
// 输入时只更新提示和状态（不重建输入框，光标不丢）；换模板时整块重建（属性随模板变）
import { h, safeImgSrc } from './dom.js';
import { isB2bItemUrl } from '../shared/url-utils.js';
import { applyReviewValue, applyTemplateChoice, autoTemplate, buildReview, currentChoice, REVIEW_GROUPS, reviewOwnValue, reviewTemplate, reviewValueError, templateChoices } from '../shared/vc-review.js';
import { pickOption } from '../shared/vc-review-attrs.js';

const MAX_THUMBS = 10;
const MANUAL_UNKNOWN = '__manual';
/** 输入框里预先填好自动值的字段（在采集到的值上直接改，而不是从空白开始输入） */
const PREFILL_KEYS = new Set(['title']);
const STATE_CLASS = { ok: '', missing: 'is-missing', error: 'is-error', default: 'is-check', warn: 'is-check', guess: 'is-check', empty: 'is-empty' };

function sourceLine(item) {
  const p = item.product ?? {};
  const platform = isB2bItemUrl(item.url) ? '京东万商' : p.isSelf === true ? '京东自营' : p.isSelf === false ? '京东 POP' : '京东';
  const crumbs = (p.crumbs ?? []).join(' > ');
  return [`SKU ${item.skuId}`, platform, crumbs && `源类目：${crumbs}`].filter(Boolean).join(' · ');
}

function matchNote(match, product) {
  const { template, category, from } = match;
  if (template) return { manual: '手动选择的模板', map: '按「类目映射」匹配', source: '按源商品类目自动匹配' }[from] ?? '';
  if (from === 'manual') return `手动指定的类目「${category.name}」没有上架模板，按默认规则检查`;
  if (category) return `源商品类目「${product?.leafCategory || category.name}」[${category.categoryId}] 没有上架模板：可以选一个模板（发布到该模板的 VC 类目），不选就按默认规则检查`;
  return '源商品没有类目ID：请选择上架模板（发布到该模板的 VC 类目）';
}

function templateSelect(ctx, match, auto) {
  const autoText = auto.template ? `自动：${auto.template.categoryName}` : auto.category ? '自动：没有模板（按默认规则）' : '自动：没有类目';
  const choice = currentChoice(match);
  const select = h(
    'select',
    { class: 'rv-tpl-select' },
    h('option', { value: '' }, autoText),
    choice === null ? h('option', { value: MANUAL_UNKNOWN }, `手动指定：${match.category?.name ?? ''}`) : null,
    ...templateChoices(ctx.catalog).map((g) => h('optgroup', { label: g.group }, ...g.options.map((o) => h('option', { value: o.value }, o.label)))),
  );
  select.value = choice ?? MANUAL_UNKNOWN;
  select.addEventListener('change', () => {
    if (select.value === MANUAL_UNKNOWN) return;
    ctx.setEdits(applyTemplateChoice(ctx.getEdits(), ctx.catalog, select.value));
    ctx.rebuild();
  });
  return select;
}

/**
 * 字段输入框：先按规则检查，合规才写进编辑内容（不合规的标红，保存时拦下）。
 * 不合规的文字记在 ctx.invalid 里：换模板、导入表格重建输入框时放回去，不会悄悄丢掉；
 * 这一项在别处被改过（导入表格填了新值）时就不放回
 */
function bindInput(input, key, ctx) {
  const pending = ctx.invalid.get(key);
  if (pending && pending.own === reviewOwnValue(ctx.getEdits(), key)) {
    input.value = pending.text;
    input.setCustomValidity(reviewValueError(key, pending.text, ctx.template()) || pending.error);
  } else ctx.invalid.delete(key);
  input.addEventListener('input', () => {
    const error = reviewValueError(key, input.value, ctx.template());
    input.setCustomValidity(error);
    if (error) ctx.invalid.set(key, { text: input.value, error, own: reviewOwnValue(ctx.getEdits(), key) });
    else {
      ctx.invalid.delete(key);
      ctx.setEdits(applyReviewValue(ctx.getEdits(), key, input.value));
    }
    ctx.refresh();
  });
}

function fieldNode(field, ctx, refs) {
  // 标题没自己改过时，直接把自动生成的标题放进输入框，可以在原标题上改（不动它就还是自动值）
  const initial = field.own || (PREFILL_KEYS.has(field.key) ? field.auto : '');
  const input = h('input', { value: initial, inputmode: field.input === 'number' ? 'decimal' : null, autocomplete: 'off' });
  bindInput(input, field.key, ctx);
  const note = h('small', { class: 'rv-note' });
  const wrap = h('label', { class: `rv-field${field.key === 'title' || field.key === 'packListing' ? ' wide' : ''}` }, h('span', {}, field.label, field.required ? h('b', { class: 'req' }, '*') : null), input, note);
  refs.set(`f:${field.key}`, { wrap, note, input });
  return wrap;
}

function attrControl(attr, ctx) {
  if (attr.kind !== 'select' || !attr.options.length) {
    const input = h('input', { value: attr.own, autocomplete: 'off' });
    bindInput(input, attr.key, ctx);
    return input;
  }
  const own = attr.own ? pickOption(attr.options, attr.own) : '';
  const select = h(
    'select',
    {},
    h('option', { value: '' }, '自动'),
    attr.own && !own ? h('option', { value: attr.own }, `${attr.own}（不在可选项里）`) : null,
    ...attr.options.map((o) => h('option', { value: o }, o)),
  );
  select.value = own || attr.own;
  select.addEventListener('change', () => {
    ctx.setEdits(applyReviewValue(ctx.getEdits(), attr.key, select.value));
    ctx.refresh();
  });
  return select;
}

function attrNode(attr, ctx, refs) {
  const note = h('small', { class: 'rv-note' });
  const control = attrControl(attr, ctx);
  const wrap = h('label', { class: 'rv-field' }, h('span', {}, attr.title, attr.required ? h('b', { class: 'req' }, '*') : null), control, note);
  refs.set(`a:${attr.id}`, { wrap, note, input: control.tagName === 'INPUT' ? control : null });
  return wrap;
}

function imagesNode(images) {
  const bad = images.problems.length > 0;
  return h(
    'div',
    { class: `rv-images${bad ? ' is-missing' : ''}` },
    h('div', { class: 'thumbs' }, ...images.main.slice(0, MAX_THUMBS).map((u, i) => h('img', { class: `thumb${i === 0 ? ' rv-first' : ''}`, src: safeImgSrc(u), referrerpolicy: 'no-referrer', alt: '', title: i === 0 ? '第一张主图：透图、图片信息识别都用它' : '' }))),
    h(
      'div',
      { class: 'sub' },
      `方图（主图）${images.main.length} 张 · 详情图 ${images.detailCount} 张 · 透图：由第一张主图自动去白底生成（发布页上请核对效果）`,
      bad ? h('div', { class: 'rv-bad' }, `缺少${images.problems.join('、')}：图片要重新采集（在任务列表里点「重新采集」）`) : null,
    ),
  );
}

const section = (title, ...children) => h('fieldset', { class: 'rv-section' }, h('legend', {}, title), ...children);

function bodyNodes(review, ctx, refs, template) {
  const groups = Object.entries(REVIEW_GROUPS).map(([g, label]) =>
    section(label, h('div', { class: 'rv-grid' }, ...review.fields.filter((f) => f.group === g).map((f) => fieldNode(f, ctx, refs)))),
  );
  const name = template ? `（模板「${template.categoryName}」）` : '';
  const attrs = (title, list, extra) =>
    list.length ? section(`${title}${name}`, extra, h('div', { class: 'rv-grid' }, ...list.map((a) => attrNode(a, ctx, refs)))) : null;
  const skuOff = review.skuAttrsOn ? null : h('p', { class: 'muted' }, '设置里关闭了“自动填写 SKU属性”，发布页上要手动填写，这里只作参考');
  const msgs = h('ul', { class: 'rv-msgs' });
  refs.set('msgs', { node: msgs });
  return [
    ...groups,
    section('图片', imagesNode(review.images)),
    template ? null : section('属性', h('p', { class: 'muted' }, '没有上架模板：属性要等打开发布页读到表单后才知道，缺的会在发布时列出来。选一个模板就能提前检查。')),
    attrs('商品属性', review.props),
    attrs('SKU属性', review.skuAttrs, skuOff),
    msgs,
  ];
}

/** 按检查结果更新一个字段/属性的颜色和提示；输入框没填时用占位提示显示自动值 */
function paint(ref, item) {
  if (!ref) return;
  ref.wrap.className = `rv-field${ref.wrap.classList.contains('wide') ? ' wide' : ''} ${STATE_CLASS[item.state] ?? ''}`.trim();
  if (ref.input) ref.input.placeholder = ('auto' in item ? item.auto : item.value) || (item.required ? '必填' : '');
  const value = item.value ? `将填写：${item.value}${item.from ? `（${item.from}）` : ''}` : '';
  ref.note.textContent = [value, item.note, item.limits].filter(Boolean).join(' · ') || ' ';
}

function messages(review) {
  const blockers = review.blockers.map((b) => h('li', { class: 'error' }, `打开发布页前会拦下：${b}`));
  const warnings = review.warnings.map((w) => h('li', { class: 'warn' }, w));
  return [...blockers, ...warnings];
}

/**
 * @param {{item: object, catalog: object, settings: object, getEdits: () => object, setEdits: (e: object) => void,
 *   onChange: () => void}} opts getEdits/setEdits：弹窗里这个商品正在改的编辑内容；onChange：状态变了（更新弹窗汇总）
 * @returns {{node: HTMLElement, state: () => {review: object, match: object, picked: boolean}, rebuild: () => void,
 *   invalidInput: () => HTMLInputElement|null, expand: () => void, setPicked: (on: boolean) => void}}
 */
export function createReviewCard({ item, catalog, settings, getEdits, setEdits, onChange }) {
  let match = null;
  let review = null;
  let picked = null;
  let open = null;
  const refs = new Map();
  const pick = h('input', { type: 'checkbox' });
  pick.addEventListener('change', () => {
    picked = pick.checked;
    onChange();
  });
  const status = h('div', { class: 'rv-status' });
  const tplBox = h('div', { class: 'rv-tpl' });
  const body = h('div', { class: 'rv-body' });
  const toggle = h('button', { type: 'button', class: 'link' });
  const head = h(
    'header',
    { class: 'rv-head' },
    h('label', { class: 'rv-pick', title: '勾选的商品在点“保存并发布”时发布' }, pick, '发布'),
    h('img', { class: 'thumb', src: safeImgSrc(item.product?.mainImages?.[0]), referrerpolicy: 'no-referrer', alt: '' }),
    h('div', { class: 'rv-name' }, h('div', { class: 'title clamp' }, item.product?.title || `SKU ${item.skuId}`), h('div', { class: 'sub' }, sourceLine(item))),
    tplBox,
    status,
    toggle,
  );
  const node = h('section', { class: 'rv-card' }, head, body);
  const setOpen = (on) => {
    open = on;
    body.hidden = !on;
    toggle.textContent = on ? '收起' : '展开';
  };
  toggle.addEventListener('click', () => setOpen(!open));

  const evaluate = () => {
    const edits = getEdits();
    match = reviewTemplate({ product: item.product, edits, settings, catalog });
    review = buildReview({ product: item.product, edits, settings, template: match.template });
  };
  const ctx = { catalog, getEdits, setEdits, invalid: new Map(), template: () => match?.template ?? null, refresh: () => refresh(), rebuild: () => rebuild() };

  function paintStatus() {
    const n = review.problems.length;
    // replaceChildren 会把 null 写成文字“null”，先去掉
    status.replaceChildren(
      ...[
        h('span', { class: `badge ${review.ready ? 'published' : 'failed'}` }, review.ready ? '齐全' : `缺 ${n || review.blockers.length} 项`),
        n ? h('div', { class: 'sub rv-missing' }, review.problems.join('、')) : null,
        review.checks ? h('div', { class: 'sub rv-checks' }, `${review.checks} 项请核对`) : null,
      ].filter(Boolean),
    );
    if (picked === null) pick.checked = review.ready;
  }

  function refresh() {
    evaluate();
    review.fields.forEach((f) => paint(refs.get(`f:${f.key}`), f));
    [...review.props, ...review.skuAttrs].forEach((a) => paint(refs.get(`a:${a.id}`), a));
    refs.get('msgs')?.node.replaceChildren(...messages(review));
    paintStatus();
    onChange();
  }

  function rebuild() {
    evaluate();
    refs.clear();
    const auto = autoTemplate({ product: item.product, edits: getEdits(), settings, catalog });
    tplBox.replaceChildren(h('label', {}, h('span', { class: 'sub' }, '上架模板'), templateSelect(ctx, match, auto)), h('small', { class: 'sub' }, matchNote(match, item.product)));
    body.replaceChildren(...bodyNodes(review, ctx, refs, match.template).filter(Boolean));
    if (open === null) setOpen(!review.ready);
    refresh();
  }

  rebuild();
  return {
    node,
    state: () => ({ review, match, picked: pick.checked }),
    rebuild,
    invalidInput: () => [...body.querySelectorAll('input')].find((i) => !i.checkValidity()) ?? null,
    expand: () => setOpen(true),
    setPicked: (on) => {
      picked = on;
      pick.checked = on;
    },
  };
}
