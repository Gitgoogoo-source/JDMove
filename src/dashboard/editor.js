// 单个商品的编辑弹窗：标题/价格/库存/品牌/UPC/类目/属性覆盖
import { h, openDialog, safeImgSrc } from './dom.js';
import { parseCateListInput, mappingSourceFor } from '../shared/category-pick.js';
import { parseAttrDefaults } from '../shared/settings.js';
import { searchShopCategories } from '../lib/category-search.js';
import { isArchived } from '../shared/brand-folders.js';
import { normalizeWareId } from '../shared/price-watch.js';
import { normalizeUpc, productUpc } from '../shared/sku-attrs.js';

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

/** 已发布商品：店铺商品编号（改价时用它打开编辑页） */
function shopIdField(item) {
  if (!isArchived(item)) return { node: null, read: () => undefined };
  const input = h('input', { value: item.shopWareId ?? '', placeholder: '如 10088812345', inputmode: 'numeric', pattern: '\\d{4,20}' });
  return {
    node: field('店铺商品编号', input, '商品在你店铺里的编号（商品编辑页地址里的那串数字），批量改价时用它打开编辑页；发布时拿到了会自动填写'),
    read: () => normalizeWareId(input.value),
  };
}

/** 商品条形码：与发布时同一套规则校验，无效时阻止保存 */
function upcInput(value, scraped) {
  const placeholder = scraped ? `${scraped}（采集到的，留空即使用）` : '如 6901234567892';
  const input = h('input', { value: value ?? '', placeholder, inputmode: 'numeric' });
  const check = () => input.setCustomValidity(input.value.trim() && !normalizeUpc(input.value) ? 'UPC 应为 8~14 位数字的有效条形码（校验位正确，不能是 0000… 这类占位值）' : '');
  input.addEventListener('input', check);
  check();
  return input;
}

/**
 * @returns {Promise<{edits: object, mapping: object|null, shopWareId?: string} | null>} shopWareId 只在已发布商品上返回
 */
export async function editItem(item, { onLog }) {
  const e = item.edits ?? {};
  const archived = isArchived(item);
  const title = h('input', { value: e.title ?? '', placeholder: item.product?.title ?? '' });
  const price = h('input', { type: 'number', step: '0.01', min: '0', value: e.price ?? '', placeholder: '留空按改价规则' });
  const shopId = shopIdField(item);
  const stock = h('input', { type: 'number', step: '1', min: '0', value: e.stock ?? '', placeholder: '留空用默认库存' });
  const brand = h('input', { value: e.brandName ?? '', placeholder: item.product?.brand?.name ?? '' });
  const upc = upcInput(e.upc, productUpc(item.product));
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
        archived ? h('small', { class: 'muted' }, '这里的售价只影响“重新发布”；要改店铺里的售价，请用“已发布”页的“批量改价”。') : null,
        shopId.node,
        field('UPC（商品条形码）', upc, '填到商品基本信息和 SKU 表的“商品条形码”、SKU属性的“最小可售单位UPC”。留空=用采集到的条形码；采集不到时需手动填写，否则这些类目提交时会报“请输入商品条形码”“条形码不能为空”'),
        cat.node,
        field('属性覆盖', overrides, '优先级高于采集数据和默认值'),
        productInfo(item.product),
        h('fieldset', {}, h('legend', {}, '最近日志'), logView),
      ),
      h('div', { class: 'dlg-foot' }, h('button', { value: 'cancel', formnovalidate: true }, '取消'), h('button', { value: 'save', class: 'primary' }, '保存')),
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
    upc: normalizeUpc(upc.value) || undefined,
    attrOverrides: parseAttrDefaults(overrides.value),
    cateList: c.cateList.length ? c.cateList : undefined,
    cateName: c.cateList.length ? c.cateName : undefined,
  };
  const source = mappingSourceFor(item.product);
  const mapping =
    c.saveMap && c.cateList.length && source ? { source, cateList: c.cateList, name: c.cateName || c.cateList.join(',') } : null;
  return { edits, mapping, shopWareId: shopId.read() };
}
