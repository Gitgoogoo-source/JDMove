// 设置弹窗
import { h, openDialog } from './dom.js';
import { PUBLISH_ACTIONS, REPRICE_ACTIONS, validateSettings } from '../shared/settings.js';
import { parseCateListInput } from '../shared/category-pick.js';
import { EDIT_URL_HINT, editUrlPreview } from './reprice-dialog.js';

const field = (label, control, hint) => h('label', { class: 'field' }, h('span', {}, label), control, hint ? h('small', {}, hint) : null);
const num = (value, attrs = {}) => h('input', { type: 'number', value, ...attrs });
const select = (value, options) =>
  h('select', {}, ...Object.entries(options).map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
const check = (checked, label) => {
  const box = h('input', { type: 'checkbox', checked });
  return { box, node: h('label', { class: 'check' }, box, label) };
};

const mapToText = (map) => map.map((m) => `${m.source} => ${m.cateList.join(',')}${m.name ? ` | ${m.name}` : ''}`).join('\n');

function textToMap(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.match(/^(.+?)\s*=>\s*([\d,\s]+?)\s*(?:\|\s*(.+))?$/))
    .filter(Boolean)
    .map((m) => ({ source: m[1].trim(), cateList: parseCateListInput(m[2]), name: (m[3] ?? '').trim() }))
    .filter((m) => m.cateList.length);
}

/**
 * @returns {Promise<{value: object, errors: string[]} | null>}
 */
export async function editSettings(settings) {
  const s = settings;
  const f = {
    minDelay: num(s.collect.minDelaySec, { min: 3 }),
    maxDelay: num(s.collect.maxDelaySec, { min: 3 }),
    scroll: check(s.collect.scrollDetail, '采集时滚动页面以加载详情图'),
    allVariants: check(s.collect.allVariants, '采集全部规格（各规格会使用当前页价格，发布前请逐个核对售价）'),
    incognito: check(s.collect.useIncognito, '在无痕窗口中采集（商家账号无法查看其他店铺商品，需在无痕窗口登录消费者账号）'),
    multiplier: num(s.price.multiplier, { step: '0.01' }),
    add: num(s.price.add, { step: '0.01' }),
    rounding: select(s.price.rounding, { cent: '保留到分', jiao: '保留到角', yuan: '取整到元', nine: '尾数 .9' }),
    stock: num(s.stock, { min: 0 }),
    prefix: h('input', { value: s.title.prefix }),
    suffix: h('input', { value: s.title.suffix }),
    removeWords: h('input', { value: s.title.removeWords.join(',') }),
    action: select(s.publish.action, PUBLISH_ACTIONS),
    pubDelay: num(s.publish.delaySec, { min: 0 }),
    maxMain: num(s.publish.maxMainImages, { min: 1, max: 10 }),
    maxDetail: num(s.publish.maxDetailImages, { min: 0, max: 50 }),
    reupload: check(s.publish.reuploadDetailImages, '详情图下载后转存到我的图片空间（推荐）'),
    skuAttrs: check(s.publish.fillSkuAttrs, '自动填写 SKU 属性面板（建议零售价等）'),
    defaultUpc: h('input', { value: s.publish.defaultUpc, placeholder: '留空则不填', inputmode: 'numeric' }),
    attrDefaults: h('textarea', {}, s.attrDefaultsText),
    packList: h('textarea', {}, s.packList),
    categoryMap: h('textarea', { placeholder: '休闲食品>巧克力 => 17991,17994,18132 | 巧克力' }, mapToText(s.categoryMap)),
    pwMinDelay: num(s.priceWatch.minDelaySec, { min: 2 }),
    pwMaxDelay: num(s.priceWatch.maxDelaySec, { min: 2 }),
    pwMargin: num(s.priceWatch.alertMargin, { min: 0, step: '0.01' }),
    pwEditUrl: h('input', { value: s.priceWatch.editUrlTemplate, placeholder: '粘贴任意一个商品的编辑页地址' }),
    pwAction: select(s.priceWatch.repriceAction, REPRICE_ACTIONS),
  };

  const dialog = h(
    'dialog',
    {},
    h(
      'form',
      { method: 'dialog' },
      h('div', { class: 'dlg-head' }, '设置'),
      h(
        'div',
        { class: 'dlg-body' },
        h('fieldset', {}, h('legend', {}, '采集'),
          h('div', { class: 'row2' }, field('每条最小间隔（秒）', f.minDelay), field('每条最大间隔（秒）', f.maxDelay)),
          h('small', { class: 'muted' }, '京东对频繁访问商品页会触发频控/验证。间隔越大越安全；触发后任务会自动暂停。'),
          f.scroll.node,
          f.incognito.node,
          f.allVariants.node),
        h('fieldset', {}, h('legend', {}, '价格与库存'),
          h('div', { class: 'row3' }, field('倍率', f.multiplier), field('加价（元）', f.add), field('取整', f.rounding)),
          field('默认库存', f.stock)),
        h('fieldset', {}, h('legend', {}, '标题'),
          h('div', { class: 'row2' }, field('前缀', f.prefix), field('后缀', f.suffix)),
          field('删除词（逗号分隔）', f.removeWords)),
        h('fieldset', {}, h('legend', {}, '发布'),
          h('div', { class: 'row2' }, field('填写完成后', f.action), field('每条发布间隔（秒）', f.pubDelay)),
          h('div', { class: 'row2' }, field('主图最多', f.maxMain), field('详情图最多', f.maxDetail)),
          f.reupload.node, f.skuAttrs.node,
          field('默认 UPC', f.defaultUpc, '源商品没有条形码、编辑里也没填 UPC 时，商品基本信息和 SKU 表的“商品条形码”、“最小可售单位UPC”填这个值；留空则不填，发布会停下提示')),
        h('fieldset', {}, h('legend', {}, '已发布商品：京东今日价检查与改价'),
          h('div', { class: 'row3' },
            field('检查最小间隔（秒）', f.pwMinDelay),
            field('检查最大间隔（秒）', f.pwMaxDelay),
            field('预警线（元）', f.pwMargin)),
          h('small', { class: 'muted' }, '预警线：售价比京东今日价高出不到这个数也提醒，0 = 只在京东价高于售价时提醒。检查价格只打开商品页读价格（用采集窗口和消费者账号），比采集快；遇到频控/验证同样会暂停。'),
          field('商品编辑页地址', f.pwEditUrl, EDIT_URL_HINT),
          editUrlPreview(f.pwEditUrl),
          field('改价后', f.pwAction, '依次尝试的按钮；第一次使用建议先选“只填写新价格”，确认编辑页上价格改对了再换成自动提交')),
        field('属性默认值', f.attrDefaults, '源页面没有对应参数时使用，每行“属性名=值”'),
        field('包装清单（可选）', f.packList),
        field('类目映射', f.categoryMap, '每行：源类目路径（任意连续几级，用 > 分隔，写上级可覆盖所有子类，多条命中时用最具体的）=> 目标类目ID路径 | 名称'),
      ),
      h('div', { class: 'dlg-foot' }, h('button', { value: 'cancel' }, '取消'), h('button', { value: 'save', class: 'primary' }, '保存')),
    ),
  );
  if ((await openDialog(dialog)) !== 'save') return null;

  return validateSettings({
    ...s,
    collect: {
      minDelaySec: Number(f.minDelay.value),
      maxDelaySec: Number(f.maxDelay.value),
      scrollDetail: f.scroll.box.checked,
      useIncognito: f.incognito.box.checked,
      allVariants: f.allVariants.box.checked,
    },
    price: { ...s.price, multiplier: Number(f.multiplier.value), add: Number(f.add.value), rounding: f.rounding.value },
    stock: Number(f.stock.value),
    title: {
      ...s.title,
      prefix: f.prefix.value,
      suffix: f.suffix.value,
      removeWords: f.removeWords.value.split(/[,，]/).map((w) => w.trim()).filter(Boolean),
    },
    publish: {
      ...s.publish,
      action: f.action.value,
      delaySec: Number(f.pubDelay.value),
      maxMainImages: Number(f.maxMain.value),
      maxDetailImages: Number(f.maxDetail.value),
      reuploadDetailImages: f.reupload.box.checked,
      fillSkuAttrs: f.skuAttrs.box.checked,
      defaultUpc: f.defaultUpc.value,
    },
    attrDefaultsText: f.attrDefaults.value,
    packList: f.packList.value,
    categoryMap: textToMap(f.categoryMap.value),
    priceWatch: {
      minDelaySec: Number(f.pwMinDelay.value),
      maxDelaySec: Number(f.pwMaxDelay.value),
      alertMargin: Number(f.pwMargin.value),
      editUrlTemplate: f.pwEditUrl.value,
      repriceAction: f.pwAction.value,
    },
  });
}
