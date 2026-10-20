// 任务表格行渲染
import { h, safeImgSrc } from './dom.js';
import { priceStatus, formatCheckTime, sameDay } from '../shared/price-watch.js';
import { canRecollect } from '../shared/store.js';

export const STATUS_TEXT = {
  pending: '待采集',
  collecting: '采集中',
  collected: '已采集',
  publishing: '发布中',
  published: '已发布',
  failed: '失败',
  need_action: '需处理',
};

/**
 * 京东价一行：倒挂/利润不足时标红并写出差价。最近一次检查失败时写出原因，
 * 仍显示上次成功检查到的价格（倒挂提醒不会因为一次打不开页面就消失）
 */
function todayPrice(check, st) {
  if (!check) return null;
  const failure = check.error
    ? [h('div', { class: 'today failed' }, '最近一次检查失败'), h('div', { class: 'sub' }, `${check.error} · ${formatCheckTime(check.errorAt ?? check.checkedAt)}`)]
    : [];
  if (!(check.price > 0)) return failure;
  const name = sameDay(check.checkedAt, Date.now()) ? '今日' : '京东';
  const verdict = st.inverted ? `倒挂：每单亏 ¥${-st.profit}` : st.alert ? `利润仅 ¥${st.profit}` : '';
  return [
    h('div', { class: st.alert ? 'today alert' : 'today' }, `${name} ¥${check.price}`, check.label ? h('span', { class: 'price-label' }, check.label) : null),
    verdict ? h('div', { class: 'verdict' }, verdict) : null,
    h('div', { class: 'sub' }, `${formatCheckTime(check.checkedAt)} 检查`),
    ...failure,
  ];
}

function priceCell(item, st) {
  const src = item.product?.price;
  if (!(src > 0)) return h('td', {}, h('span', { class: 'sub' }, st.sale > 0 ? `售价 ${st.sale}` : '—'), todayPrice(item.priceCheck, st));
  return h(
    'td',
    {},
    h('div', { title: '采集时的京东价' }, `源 ¥${src}`),
    h('div', { class: 'sub' }, `售 ¥${st.sale ?? '—'}`),
    todayPrice(item.priceCheck, st),
  );
}

function shopIdLine(item) {
  if (!item.publishedAt && item.status !== 'published') return null;
  return item.shopWareId
    ? h('div', { class: 'sub', title: '店铺商品编号（改价时用）' }, `店铺编号 ${item.shopWareId}`)
    : h('div', { class: 'sub missing', title: '改价前请在“编辑”中填写' }, '店铺编号未填写');
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
  const st = priceStatus(item, ctx.settings);
  return h(
    'tr',
    { dataset: { id: item.id }, class: st.alert ? 'price-alert' : '' },
    h('td', {}, h('input', { type: 'checkbox', checked: ctx.checked, onchange: (e) => ctx.onCheck(item.id, e.target.checked) })),
    h('td', {}, img ? h('img', { class: 'thumb', src: img, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' }) : h('div', { class: 'thumb' })),
    h(
      'td',
      {},
      h('div', { class: 'title' }, item.edits?.title || p?.title || '（未采集）'),
      h('a', { class: 'sub', href: item.url, target: '_blank', rel: 'noreferrer' }, `SKU ${item.skuId}`),
      shopIdLine(item),
      localCell(item.local),
    ),
    priceCell(item, st),
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
        canRecollect(item)
          ? h('button', { class: 'link', disabled: ctx.busy, title: '重新打开京东商品页采集，覆盖已采集的数据（编辑内容保留）', onclick: () => ctx.onRecollect(item.id) }, '重新采集')
          : null,
        h('button', { class: 'link', disabled: ctx.busy, onclick: () => ctx.onRemove(item.id) }, '删除'),
      ),
    ),
  );
}
