// 单个商品的编辑弹窗：标题/价格/库存/品牌/类目/属性覆盖
import { h, openDialog, safeImgSrc } from './dom.js';
import { parseCateListInput, mappingSourceFor } from '../shared/category-pick.js';
import { parseAttrDefaults } from '../shared/settings.js';
import { searchShopCategories } from '../lib/category-search.js';

const field = (label, control, hint) => h('label', { class: 'field' }, h('span', {}, label), control, hint ? h('small', {}, hint) : null);

function overridesToText(overrides) {
  return Object.entries(overrides ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function categoryPicker(item, onLog) {
  const cateInput = h('input', {
    value: item.edits?.cateList?.join(',') ?? '',
    placeholder: '留空=自动匹配；或填类目ID，如 17991,17994,18132',
  });
  const nameInput = h('input', { type: 'hidden', value: item.edits?.cateName ?? '' });
  const keyword = h('input', { value: item.product?.leafCategory ?? '', placeholder: '搜索关键词' });
  const results = h('div', { class: 'cat-results' });
  const searchBtn = h('button', { type: 'button' }, '搜索店铺类目');
  searchBtn.addEventListener('click', async () => {
    searchBtn.disabled = true;
    results.replaceChildren(h('span', { class: 'muted' }, '搜索中（会在工作窗口打开类目页）…'));
    try {
      const list = await searchShopCategories(keyword.value.trim());
      results.replaceChildren(
        ...(list.length
          ? list.map((r) =>
              h('button', {
                type: 'button',
                onclick: () => {
                  cateInput.value = r.path.map((n) => n.id).join(',');
                  nameInput.value = r.path.map((n) => n.name).join(' > ');
                },
              }, r.text),
            )
          : [h('span', { class: 'muted' }, '没有结果，换个关键词试试')]),
      );
    } catch (e) {
      results.replaceChildren(h('span', { class: 'muted' }, e.message));
      onLog(`类目搜索失败：${e.message}`);
    } finally {
      searchBtn.disabled = false;
    }
  });
  const saveMap = h('input', { type: 'checkbox', checked: true });
  const node = h(
    'fieldset',
    {},
    h('legend', {}, '目标类目'),
    field('类目ID路径', cateInput, '选择搜索结果中的“末级类目”，否则发布页无法打开'),
    h('div', { class: 'row2' }, keyword, searchBtn),
    results,
    h('label', { class: 'check' }, saveMap, '同时记住：以后同一源类目自动使用此类目'),
    nameInput,
  );
  return {
    node,
    read: () => ({ cateList: parseCateListInput(cateInput.value), cateName: nameInput.value, saveMap: saveMap.checked }),
  };
}

function productInfo(p) {
  if (!p) return h('p', { class: 'muted' }, '尚未采集');
  return h(
    'fieldset',
    {},
    h('legend', {}, '采集数据'),
    h('div', { class: 'thumbs' }, ...p.mainImages.slice(0, 10).map((u) => h('img', { class: 'thumb', src: safeImgSrc(u), referrerpolicy: 'no-referrer', alt: '' }))),
    h('div', { class: 'sub' }, `详情图 ${p.detailImages.length} 张 · 规格 ${p.saleDims.map((d) => `${d.name}(${d.values.length})`).join(' ') || '无'} · 品牌 ${p.brand?.name || '—'}`),
    h('dl', { class: 'params' }, ...p.params.flatMap((x) => [h('dt', {}, x.name), h('dd', {}, x.value)])),
  );
}

/**
 * @returns {Promise<{edits: object, mapping: object|null} | null>}
 */
export async function editItem(item, { onLog }) {
  const e = item.edits ?? {};
  const title = h('input', { value: e.title ?? '', placeholder: item.product?.title ?? '' });
  const price = h('input', { type: 'number', step: '0.01', min: '0', value: e.price ?? '', placeholder: '留空按改价规则' });
  const stock = h('input', { type: 'number', step: '1', min: '0', value: e.stock ?? '', placeholder: '留空用默认库存' });
  const brand = h('input', { value: e.brandName ?? '', placeholder: item.product?.brand?.name ?? '' });
  const overrides = h('textarea', { placeholder: '属性名=值，每行一条，如：\n产地=中国大陆\n保质期=365' }, overridesToText(e.attrOverrides));
  const cat = categoryPicker(item, onLog);
  const logView = h('pre', { class: 'sub' }, (item.log ?? []).join('\n') || '暂无日志');

  const dialog = h(
    'dialog',
    {},
    h(
      'form',
      { method: 'dialog' },
      h('div', { class: 'dlg-head' }, `编辑 SKU ${item.skuId}`),
      h(
        'div',
        { class: 'dlg-body' },
        field('标题', title, '留空=按设置自动清洗源标题；京东标题上限 60 字符（汉字算 2）'),
        h('div', { class: 'row3' }, field('售价', price), field('库存', stock), field('品牌名', brand, '必须是店铺已授权品牌')),
        cat.node,
        field('属性覆盖', overrides, '优先级高于采集数据和默认值'),
        productInfo(item.product),
        h('fieldset', {}, h('legend', {}, '最近日志'), logView),
      ),
      h('div', { class: 'dlg-foot' }, h('button', { value: 'cancel' }, '取消'), h('button', { value: 'save', class: 'primary' }, '保存')),
    ),
  );
  const result = await openDialog(dialog);
  if (result !== 'save') return null;

  const c = cat.read();
  const edits = {
    title: title.value.trim() || undefined,
    price: Number(price.value) > 0 ? Number(price.value) : undefined,
    stock: stock.value === '' ? undefined : Math.max(0, Math.floor(Number(stock.value))),
    brandName: brand.value.trim() || undefined,
    attrOverrides: parseAttrDefaults(overrides.value),
    cateList: c.cateList.length ? c.cateList : undefined,
    cateName: c.cateList.length ? c.cateName : undefined,
  };
  const source = mappingSourceFor(item.product);
  const mapping =
    c.saveMap && c.cateList.length && source ? { source, cateList: c.cateList, name: c.cateName || c.cateList.join(',') } : null;
  return { edits, mapping };
}
