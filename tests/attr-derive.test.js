import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPropPlan } from '../src/shared/attr-mapping.js';

const opts = (labels) => labels.map((label, i) => ({ label, value: String(i + 1) }));
const labelOf = (attr, plan) => attr.options.find((o) => o.value === plan.values[attr.field])?.label;

// 京麦（京喜通）休闲零食 > 糖巧布丁 > 巧克力 [18132] 的真实必填下拉项
const SALE_UNIT = { field: 'unit', title: '销售单位', kind: 'select', required: true, options: opts(['块', '板', '条', '瓶', '盒', '袋', '组', '箱']) };
const ORIGIN = {
  field: 'origin',
  title: '产地',
  kind: 'select',
  required: true,
  options: opts(['奥地利', '比利时', '德国', '法国', '港澳台', '美国', '其它', '日本', '瑞士', '意大利', '英国', '中国大陆']),
};
const PACKAGE = { field: 'pkg', title: '包装', kind: 'select', required: true, options: opts(['罐装', '盒装', '条状', '其它', '礼盒装', '组合装']) };
const ATTRS = [SALE_UNIT, ORIGIN, PACKAGE];

// SKU 100035179134 实际采集到的数据：商品页上没有产地、销售单位
const dove = {
  title: '德芙香浓黑巧克力 桶装480g 休闲零食糖果 节日礼物 送女友礼物',
  brand: { id: 5962, name: '德芙（Dove）' },
  params: [
    { name: '保质期', value: '364天' },
    { name: '包装形式', value: '桶装' },
    { name: '可可脂含量', value: '40%-70%' },
    { name: '品牌', value: '德芙（Dove）' },
    { name: '商品编号', value: '100035179134' },
  ],
};

test('德芙桶装：三个必填下拉都能填上，不再阻塞发布', () => {
  const plan = buildPropPlan(ATTRS, dove);
  assert.deepEqual(plan.missingRequired, []);
  assert.equal(labelOf(PACKAGE, plan), '罐装');
  assert.equal(labelOf(SALE_UNIT, plan), '瓶');
  assert.equal(labelOf(ORIGIN, plan), '中国大陆');
  const unit = plan.report.find((r) => r.field === 'unit');
  assert.equal(unit.status, 'guessed');
  assert.equal(unit.label, '瓶');
});

test('包装：源值与选项完全对不上时退到“其它”', () => {
  const plan = buildPropPlan([PACKAGE], { params: [{ name: '包装形式', value: '散装称重' }] });
  assert.equal(labelOf(PACKAGE, plan), '其它');
});

test('销售单位：从包装形式/标题里的容器字推断', () => {
  const plan = buildPropPlan([SALE_UNIT], { title: '奥利奥夹心饼干 6袋装', params: [] });
  assert.equal(labelOf(SALE_UNIT, plan), '袋');
});

// SKU 100012979704 实际采集到的数据：商品页参数只有保质期、饼干种类，没有包装、销售单位
const glicoGiftBox = {
  title: '格力高（Glico）儿童童趣礼盒330g 含贴纸 零食礼盒大礼包零食休闲小吃中秋送礼',
  brand: { id: 25570, name: '格力高（Glico）' },
  params: [
    { name: '保质期', value: '365天' },
    { name: '饼干种类', value: '其他 夹心饼干 韧性饼干' },
  ],
  saleDims: [{ name: '规格', values: ['儿童童趣礼盒（含儿童贴纸）330g'] }],
};

test('格力高礼盒：源页面没有包装、销售单位时从标题里的“礼盒”推断', () => {
  const plan = buildPropPlan([PACKAGE, SALE_UNIT], glicoGiftBox);
  assert.deepEqual(plan.missingRequired, []);
  assert.equal(labelOf(PACKAGE, plan), '礼盒装');
  assert.equal(labelOf(SALE_UNIT, plan), '盒');
  const pkg = plan.report.find((r) => r.field === 'pkg');
  assert.equal(pkg.status, 'guessed');
  assert.equal(pkg.source, '标题');
});

test('包装：没有“礼盒装”选项时，礼盒退到“盒装”', () => {
  const plain = { ...PACKAGE, options: opts(['罐装', '盒装', '袋装', '其它']) };
  const plan = buildPropPlan([plain], glicoGiftBox);
  assert.equal(labelOf(plain, plan), '盒装');
});

// SKU 100064560914 实际采集到的数据：标题写“组合装…大礼包”、规格写“混合装”，参数里没有包装、销售单位
const glicoCombo = {
  title: '格力高（Glico）(glico)百醇百奇百力滋系列组合装237g 休闲零食大礼包儿童送礼',
  brand: { id: 25570, name: '格力高（Glico）' },
  leafCategory: '饼干礼盒/礼包',
  params: [
    { name: '保质期', value: '365天' },
    { name: '饼干种类', value: '夹心饼干 韧性饼干' },
  ],
  saleDims: [{ name: '规格', values: ['混合系列混合装237g'] }],
};

test('格力高组合装：从标题里的“组合装”推断包装、销售单位，不再阻塞发布', () => {
  const plan = buildPropPlan([PACKAGE, SALE_UNIT], glicoCombo);
  assert.deepEqual(plan.missingRequired, []);
  assert.equal(labelOf(PACKAGE, plan), '组合装');
  assert.equal(labelOf(SALE_UNIT, plan), '组');
  const pkg = plan.report.find((r) => r.field === 'pkg');
  assert.equal(pkg.status, 'guessed');
  assert.equal(pkg.source, '标题');
});

test('包装：第一个容器词没有对应选项时，试标题里的下一个（组合装 → 大礼包）', () => {
  const plain = { ...PACKAGE, options: opts(['罐装', '盒装', '袋装', '其它']) };
  const unit = { ...SALE_UNIT, options: opts(['块', '板', '条', '瓶', '盒', '袋']) };
  const plan = buildPropPlan([plain, unit], glicoCombo);
  assert.deepEqual(plan.missingRequired, []);
  assert.equal(labelOf(plain, plan), '袋装');
  assert.equal(labelOf(unit, plan), '袋');
});

test('销售单位：规格里的“混合装”按组合装处理', () => {
  const plan = buildPropPlan([SALE_UNIT], { title: '某品牌饼干 237g', params: [], saleDims: [{ name: '规格', values: ['混合装237g'] }] });
  assert.equal(labelOf(SALE_UNIT, plan), '组');
});

test('包装：标题、规格看不出容器时，用类目名里的“礼盒/礼包”', () => {
  const plan = buildPropPlan([PACKAGE, SALE_UNIT], { title: '某品牌饼干 400g', params: [], leafCategory: '饼干礼盒/礼包' });
  assert.deepEqual(plan.missingRequired, []);
  assert.equal(labelOf(PACKAGE, plan), '礼盒装');
  assert.equal(plan.report.find((r) => r.field === 'pkg').source, '类目(饼干礼盒/礼包)');
});

test('包装：从标题里的“X装”推断', () => {
  const plan = buildPropPlan([PACKAGE], { title: '某品牌曲奇饼干 罐装908g', params: [] });
  assert.equal(labelOf(PACKAGE, plan), '罐装');
});

test('包装：标题和规格里都看不出容器时不乱填“其它”，仍提示必填', () => {
  const plan = buildPropPlan([PACKAGE, SALE_UNIT], { title: '某品牌苏打饼干 400g', params: [], saleDims: [{ name: '规格', values: ['400g'] }] });
  assert.deepEqual(plan.missingRequired, ['包装', '销售单位']);
});

test('用户设置的包装默认值优先于标题推断', () => {
  const plan = buildPropPlan([PACKAGE], glicoGiftBox, { defaults: { 包装: '组合装' } });
  assert.equal(labelOf(PACKAGE, plan), '组合装');
});

test('产地：标题里出现选项中的国家时用该国家', () => {
  const plan = buildPropPlan([ORIGIN], { title: '瑞士莲 Lindt 瑞士进口 特醇排装黑巧克力', params: [] });
  assert.equal(labelOf(ORIGIN, plan), '瑞士');
});

test('产地：只写“进口”但看不出国家时不乱填，仍提示必填', () => {
  const plan = buildPropPlan([ORIGIN], { title: '进口黑巧克力 100g', params: [] });
  assert.deepEqual(plan.missingRequired, ['产地']);
});

test('用户设置的属性默认值优先于推断', () => {
  const plan = buildPropPlan([SALE_UNIT, ORIGIN], dove, { defaults: { 销售单位: '盒', 产地: '比利时' } });
  assert.equal(labelOf(SALE_UNIT, plan), '盒');
  assert.equal(labelOf(ORIGIN, plan), '比利时');
});

test('源数据里明确的产地仍优先于默认值', () => {
  const plan = buildPropPlan([ORIGIN], { params: [{ name: '原产地', value: '德国' }] }, { defaults: { 产地: '比利时' } });
  assert.equal(labelOf(ORIGIN, plan), '德国');
});

test('销售期限：默认值“新日期”选中“新日期…”，而不是包含它的“次新日期…”', () => {
  const PERIOD = {
    field: 'period',
    title: '销售期限',
    kind: 'select',
    required: true,
    options: opts(['新日期：未过保质期限的1/4', '次新日期：未过保质期限的1/3', '常规日期：未过保质期限的1/2']),
  };
  const plan = buildPropPlan([PERIOD], { params: [] }, { defaults: { 销售期限: '新日期' } });
  assert.equal(labelOf(PERIOD, plan), '新日期：未过保质期限的1/4');
});
