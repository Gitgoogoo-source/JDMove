// 任务表格行渲染
import { h, safeImgSrc } from './dom.js';
import { computePrice } from '../shared/pricing.js';

export const STATUS_TEXT = {
  pending: '待采集',
  collecting: '采集中',
  collected: '已采集',
  publishing: '发布中',
  published: '已发布',
  failed: '失败',
  need_action: '需处理',
};

function priceCell(item, settings) {
  const src = item.product?.price;
  if (!(src > 0)) return h('td', {}, h('span', { class: 'sub' }, item.edits?.price ? `售价 ${item.edits.price}` : '—'));
  const target = Number(item.edits?.price) > 0 ? Number(item.edits.price) : computePrice(src, settings.price);
  return h('td', {}, h('div', {}, `源 ¥${src}`), h('div', { class: 'sub' }, `售 ¥${target ?? '—'}`));
}

function categoryCell(item) {
  const source = item.product?.crumbs?.slice(0, 3).join(' > ') || '—';
  const target = item.edits?.cateList?.length
    ? `指定：${item.edits.cateName || item.edits.cateList.join(',')}`
    : item.target?.name
      ? `已用：${item.target.name}`
      : '自动匹配';
  return h('td', {}, h('div', { class: 'sub' }, source), h('div', {}, target));
}

/**
 * @param {object} item
 * @param {{settings: object, checked: boolean, busy: boolean, onCheck: Function, onEdit: Function, onRemove: Function, onRetry: Function}} ctx
 */
export function renderRow(item, ctx) {
  const p = item.product;
  const img = safeImgSrc(p?.mainImages?.[0]);
  return h(
    'tr',
    { dataset: { id: item.id } },
    h('td', {}, h('input', { type: 'checkbox', checked: ctx.checked, onchange: (e) => ctx.onCheck(item.id, e.target.checked) })),
    h('td', {}, img ? h('img', { class: 'thumb', src: img, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' }) : h('div', { class: 'thumb' })),
    h(
      'td',
      {},
      h('div', { class: 'title' }, item.edits?.title || p?.title || '（未采集）'),
      h('a', { class: 'sub', href: item.url, target: '_blank', rel: 'noreferrer' }, `SKU ${item.skuId}`),
    ),
    priceCell(item, ctx.settings),
    categoryCell(item),
    h(
      'td',
      {},
      h('span', { class: `badge ${item.status}` }, STATUS_TEXT[item.status] ?? item.status),
      item.message ? h('div', { class: 'message' }, item.message) : null,
    ),
    h(
      'td',
      {},
      h(
        'div',
        { class: 'ops' },
        h('button', { class: 'link', disabled: ctx.busy, onclick: () => ctx.onEdit(item.id) }, '编辑'),
        h('button', { class: 'link', disabled: ctx.busy, onclick: () => ctx.onRetry(item.id) }, p ? '重新发布' : '采集'),
        h('button', { class: 'link', disabled: ctx.busy, onclick: () => ctx.onRemove(item.id) }, '删除'),
      ),
    ),
  );
}
