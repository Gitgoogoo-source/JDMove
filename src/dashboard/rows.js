// 任务表格行渲染
import { h, safeImgSrc } from './dom.js';
import { canRecollect } from '../shared/store.js';

export const STATUS_TEXT = {
  pending: '待采集',
  collecting: '采集中',
  collected: '已采集',
  publishing: '发布中',
  failed: '失败',
  need_action: '需处理',
};

const positive = (v) => (Number(v) > 0 ? Number(v) : null);

/** 价格：采集时源商品页的价格 + 发布时要填的 VC 京东价 / 协议价 */
function priceCell(item) {
  const src = item.product?.price;
  const vc = item.edits?.vc ?? {};
  const agreement = positive(vc.agreementPrice);
  return h(
    'td',
    {},
    src > 0 ? h('div', { title: '采集时源商品页显示的价格' }, `源 ¥${src}`) : null,
    h('div', { class: 'sub', title: '发布时填的 VC 京东价' }, `京东价 ¥${positive(vc.jdPrice) ?? '—'}`),
    agreement ? h('div', { class: 'sub', title: '协议价：不填进发布页，发布成功后写进上架总表' }, `协议价 ¥${agreement}`) : null,
  );
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

function localCell(local) {
  if (local?.error) return h('div', { class: 'sub local-error' }, `本地保存失败：${local.error}`);
  if (!local?.dir) return null;
  const miss = local.failed ? `（${local.failed} 张图片未下载）` : '';
  return h('div', { class: 'sub local', title: '相对存储位置的文件夹' }, `本地：${local.dir}${miss}`);
}

/**
 * @param {object} item
 * @param {{settings: object, checked: boolean, busy: boolean, onCheck: Function, onEdit: Function, onRemove: Function, onRetry: Function,
 *   onRecollect: Function}} ctx
 */
export function renderRow(item, ctx) {
  const p = item.product;
  const img = safeImgSrc(p?.mainImages?.[0]);
  return h(
    'tr',
    { dataset: { id: item.id } },
    h('td', {}, h('input', {
      class: 'task-check',
      type: 'checkbox',
      checked: ctx.checked,
      'aria-label': `勾选 SKU ${item.skuId}`,
      onchange: (e) => ctx.onCheck(item.id, e.target.checked),
    })),
    h('td', {}, img ? h('img', { class: 'thumb', src: img, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' }) : h('div', { class: 'thumb' })),
    h(
      'td',
      {},
      h('div', { class: 'title' }, item.edits?.title || p?.title || '（未采集）'),
      h('a', { class: 'sub', href: item.url, target: '_blank', rel: 'noreferrer' }, `SKU ${item.skuId}`),
      p?.vc?.spuId && p.vc.spuId !== item.skuId ? h('div', { class: 'sub' }, `SPU ${p.vc.spuId}`) : null,
      localCell(item.local),
    ),
    priceCell(item),
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
        h('button', { class: 'link', disabled: ctx.busy, onclick: () => ctx.onRetry(item.id) }, p ? '发布' : '采集'),
        canRecollect(item)
          ? h('button', { class: 'link', disabled: ctx.busy, title: '重新打开京东商品页采集，覆盖已采集的数据（编辑内容保留）', onclick: () => ctx.onRecollect(item.id) }, '重新采集')
          : null,
        h('button', { class: 'link', disabled: ctx.busy, onclick: () => ctx.onRemove(item.id) }, '删除'),
      ),
    ),
  );
}
