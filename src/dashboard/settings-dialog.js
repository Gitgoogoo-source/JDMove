// 设置弹窗
import { h, openDialog } from './dom.js';
import { PUBLISH_ACTIONS, VC_PACK_TYPES, validateSettings } from '../shared/settings.js';
import { parseCateListInput } from '../shared/category-pick.js';

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
    prefix: h('input', { value: s.title.prefix }),
    suffix: h('input', { value: s.title.suffix }),
    removeWords: h('input', { value: s.title.removeWords.join(',') }),
    action: select(s.publish.action, PUBLISH_ACTIONS),
    pubDelay: num(s.publish.delaySec, { min: 0 }),
    maxMain: num(s.publish.maxMainImages, { min: 1, max: 10 }),
    maxDetail: num(s.publish.maxDetailImages, { min: 0, max: 50 }),
    reupload: check(s.publish.reuploadDetailImages, '详情图下载后转存到我的图片空间（推荐）'),
    skuAttrs: check(s.publish.fillSkuAttrs, '自动填写 SKU 属性面板'),
    throttleCooldown: num(s.publish.throttleCooldownMin, { min: 0, max: 1440 }),
    attrDefaults: h('textarea', {}, s.attrDefaultsText),
    packList: h('textarea', {}, s.packList),
    categoryMap: h('textarea', { placeholder: '休闲食品>巧克力 => 17991,17994,18132 | 巧克力' }, mapToText(s.categoryMap)),
    pwMinDelay: num(s.priceWatch.minDelaySec, { min: 2 }),
    pwMaxDelay: num(s.priceWatch.maxDelaySec, { min: 2 }),
    pwMargin: num(s.priceWatch.alertMargin, { min: 0, step: '0.01' }),
    vcErp: h('input', { value: s.vc.erpCode, placeholder: '如 xudezhi.6；留空沿用页面默认值', pattern: '[A-Za-z0-9._\\-]{1,50}' }),
    vcUnit: h('input', { value: s.vc.saleUnit, placeholder: '留空按包装形式/规格推断，如 箱、提、包' }),
    vcPackSpec: num(s.vc.packSpecification, { min: 1, step: '1' }),
    vcPackType: select(s.vc.packType, Object.fromEntries(VC_PACK_TYPES.map((t) => [t, t]))),
    vcWarranty: h('input', { value: s.vc.warranty }),
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
        h('fieldset', {}, h('legend', {}, '标题'),
          h('div', { class: 'row2' }, field('前缀', f.prefix), field('后缀', f.suffix)),
          field('删除词（逗号分隔）', f.removeWords)),
        h('fieldset', {}, h('legend', {}, '发布（VC 自营，供应商后台 vcp.jd.com）'),
          h('small', { class: 'muted' }, '直接打开 vcProductPublish 发布页（用采集到的类目和品牌ID）；市场价/京东价/采购价/采购员/销售员在「编辑」中填写，商品多时用“表格导入价格/ERP”批量填写。'),
          h('div', { class: 'row2' }, field('填写完成后', f.action, '只点“保存草稿”（不点“发布商品”），请到 VC 后台草稿箱检查后再提交；选“只填写，不保存”时不点按钮'), field('每条发布间隔（秒）', f.pubDelay)),
          h('div', { class: 'row2' }, field('主图最多', f.maxMain), field('详情图最多', f.maxDetail)),
          f.reupload.node, f.skuAttrs.node,
          field('限流后冷却（分钟）', f.throttleCooldown, '保存时返回“操作过于频繁”会暂停发布；这段时间内再点“发布选中”会先提醒。0 = 不提醒')),
        h('fieldset', {}, h('legend', {}, 'VC 自营'),
          field('默认采购员/销售员 ERP', f.vcErp, '商品没有单独填写时，采购员和销售员都用这个 ERP；单个商品可在「编辑」或表格导入里另填'),
          h('div', { class: 'row3' }, field('销售单位', f.vcUnit), field('包装规格', f.vcPackSpec), field('商品包装', f.vcPackType)),
          field('质保期', f.vcWarranty, '源商品主数据里没有质保时使用'),
          h('small', { class: 'muted' }, '没有条形码的商品请在「编辑 → UPC」填写（同一个条码填到所有商品会被判重码，入仓还要贴码）。')),
        h('fieldset', {}, h('legend', {}, '已发布商品：京东今日价检查'),
          h('div', { class: 'row3' },
            field('检查最小间隔（秒）', f.pwMinDelay),
            field('检查最大间隔（秒）', f.pwMaxDelay),
            field('预警线（元）', f.pwMargin)),
          h('small', { class: 'muted' }, '售价是发布时填的 VC 京东价。预警线：售价比京东今日价高出不到这个数也提醒，0 = 只在京东今日价高于售价时提醒。检查价格只打开商品页读价格（用采集窗口和消费者账号），比采集快；遇到频控/验证同样会暂停。')),
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
      // 留空时用默认值，而不是变成 0（0 表示不提醒）
      throttleCooldownMin: f.throttleCooldown.value.trim() === '' ? undefined : Number(f.throttleCooldown.value),
    },
    vc: {
      erpCode: f.vcErp.value,
      saleUnit: f.vcUnit.value,
      packSpecification: Number(f.vcPackSpec.value),
      packType: f.vcPackType.value,
      warranty: f.vcWarranty.value,
    },
    attrDefaultsText: f.attrDefaults.value,
    packList: f.packList.value,
    categoryMap: textToMap(f.categoryMap.value),
    priceWatch: {
      minDelaySec: Number(f.pwMinDelay.value),
      maxDelaySec: Number(f.pwMaxDelay.value),
      alertMargin: Number(f.pwMargin.value),
    },
  });
}
