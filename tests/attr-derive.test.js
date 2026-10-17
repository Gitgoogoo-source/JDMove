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
