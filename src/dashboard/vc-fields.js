// 编辑弹窗里的 VC 自营字段：采集不到、需要手动填写的市场价/京东价/采购价/采购员 ERP/销售员 ERP，
// 以及源商品主数据缺失时可以补填的型号、品牌ID、包装长宽高、毛重、包装清单（采集到的值显示为占位提示）
import { h } from './dom.js';
import { VC_PRICE_LABELS } from '../shared/vc-plan.js';
import { ERP_LABELS, ownErp, withErp } from '../shared/vc-erp.js';
import { vcSourceFields } from '../shared/vc-source.js';

const field = (label, control, hint) => h('label', { class: 'field' }, h('span', {}, label), control, hint ? h('small', {}, hint) : null);
const ERP_PATTERN = '[A-Za-z0-9._\\-]{1,50}';

const numberInput = (value, placeholder, step = '0.01') =>
  h('input', { type: 'number', step, min: '0', value: value ?? '', placeholder: placeholder == null ? '' : String(placeholder) });

const positive = (input) => (Number(input.value) > 0 ? Number(input.value) : undefined);
const text = (input) => input.value.trim() || undefined;

/**
 * @param {object} item
 * @param {{erpCode?: string}} vcSettings 设置里的 VC 默认值（ERP 留空时的提示）
 * @returns {{node: HTMLElement, read: () => object|undefined}} read：没有填任何值时返回 undefined
 */
export function vcFields(item, vcSettings = {}) {
  const own = item.edits?.vc ?? {};
  const src = item.product?.vc ?? {};
  const prices = Object.fromEntries(Object.entries(VC_PRICE_LABELS).map(([k]) => [k, numberInput(own[k], '必填')]));
  const erpPlaceholder = vcSettings.erpCode ? `留空用设置里的 ${vcSettings.erpCode}` : '留空沿用页面默认值';
  const ownCodes = ownErp(own);
  const erp = Object.fromEntries(Object.keys(ERP_LABELS).map((k) => [k, h('input', { value: ownCodes[k], placeholder: erpPlaceholder, pattern: ERP_PATTERN })]));
  // 采集到的可信值（型号可以是货号；0 和占位值不显示，见 vcSourceFields）
  const trusted = vcSourceFields(item.product);
  const modelHint = trusted.model ? `${trusted.model}（源商品${trusted.modelFrom}）` : '源商品没有型号和货号，必填';
  const model = h('input', { value: own.model ?? '', placeholder: modelHint });
  const brandId = numberInput(own.brandId, src.brandId ?? item.product?.brand?.id ?? '必填', '1');
  const required = trusted.placeholders.length ? '源数据是占位值，必填' : '必填';
  const dims = {
    lengthMm: numberInput(own.lengthMm, trusted.lengthMm ?? required, '1'),
    widthMm: numberInput(own.widthMm, trusted.widthMm ?? required, '1'),
    heightMm: numberInput(own.heightMm, trusted.heightMm ?? required, '1'),
    weightKg: numberInput(own.weightKg, trusted.weightKg ?? required, '0.001'),
  };
  const packListing = h('input', {
    value: own.packListing ?? '',
    placeholder: item.product?.packList || '源商品没有包装清单，留空按设置的包装清单或“品牌 类目 x1”',
  });

  const node = h(
    'fieldset',
    {},
    h('legend', {}, 'VC 自营（这几项采集不到，需要手动填写；商品多时可用“表格导入价格/ERP”批量填写）'),
    h('div', { class: 'row3' }, ...Object.entries(VC_PRICE_LABELS).map(([k, label]) => field(`${label}（元）`, prices[k]))),
    h('div', { class: 'row2' }, field(ERP_LABELS.buyer, erp.buyer, '发布时在页面上输入 ERP 并选中对应的人'), field(ERP_LABELS.saler, erp.saler, '是同一个人时两个填一样的')),
    h('div', { class: 'row2' }, field('型号', model, '留空用采集到的型号'), field('品牌ID', brandId, '留空用采集到的品牌ID，必须是账号已授权的品牌')),
    h('div', { class: 'row3' }, field('包装长(mm)', dims.lengthMm), field('包装宽(mm)', dims.widthMm), field('包装高(mm)', dims.heightMm)),
    h('div', { class: 'row2' }, field('毛重(kg)', dims.weightKg, '长宽高、毛重留空用采集到的值；长宽高取整数，毛重最多 3 位小数'), field('包装清单', packListing, '留空用采集到的包装清单')),
  );

  const read = () => {
    const values = {
      ...Object.fromEntries(Object.entries(prices).map(([k, input]) => [k, positive(input)])),
      // 两个相同时存成 erpCode，和以前的数据一样
      ...withErp({}, { buyer: text(erp.buyer), saler: text(erp.saler) }),
      model: text(model),
      brandId: positive(brandId),
      ...Object.fromEntries(Object.entries(dims).map(([k, input]) => [k, positive(input)])),
      packListing: text(packListing),
    };
    const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
    return Object.keys(filled).length ? filled : undefined;
  };
  return { node, read };
}
