// 用真实采集结果（2026-10 京东新版商品页）+ 真实后台类目结构做端到端的纯逻辑回归
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeProduct, validateProduct } from '../src/shared/product-normalize.js';
import { buildPublishPlan } from '../src/shared/publish-plan.js';
import { mergeSettings } from '../src/shared/settings.js';

const raw = JSON.parse(readFileSync(new URL('./fixtures/item-100035179134.raw.json', import.meta.url), 'utf8'));

const opt = (label, value) => ({ label, value });
// 京喜通 休闲零食 > 糖巧布丁 > 巧克力 [18132] 的属性（选项只录入了观察到的部分）
const chocolateSchema = {
  saleDimNames: ['规格', '口味'],
  attrs: [
    { field: '256104', title: '本品与最小可售单位数量关系', kind: 'input', required: true, options: [] },
    { field: '156403', title: '规格', kind: 'input', required: true, options: [] },
    { field: '156406', title: '销售单位', kind: 'select', required: true, options: [opt('块', '1'), opt('板', '2'), opt('条', '3'), opt('瓶', '4'), opt('桶', '5')] },
    { field: '149367', title: '产地', kind: 'select', required: true, options: [opt('奥地利', 'a'), opt('比利时', 'b'), opt('丹麦', 'c'), opt('德国', '760987'), opt('中国大陆', 'cn')] },
    { field: '156404', title: '净含量', kind: 'input', required: true, options: [] },
    { field: '149365', title: '包装', kind: 'select', required: true, options: [opt('罐装', 'g'), opt('盒装', 'h'), opt('条状', 't'), opt('其它', 'q'), opt('袋装', 'd'), opt('桶装', 'tz')] },
    { field: '156405', title: '保质期', kind: 'input', required: true, suffix: '天', options: [] },
    { field: '165115', title: '销售期限', kind: 'select', required: true, options: [opt('新日期：未过保质期1/3', 'n')] },
    { field: '149371', title: '可可脂含量', kind: 'select', required: false, options: [opt('40%以下', 'l'), opt('40%-70%', 'm'), opt('71%-85%', 'h')] },
  ],
};

test('real item normalizes into a publishable product', () => {
  const p = normalizeProduct(raw);
  assert.equal(p.title, '德芙香浓黑巧克力 桶装480g 休闲零食糖果 节日礼物 送女友礼物');
  assert.deepEqual(p.brand, { id: 5962, name: '德芙（Dove）' });
  assert.equal(p.leafCategory, '牛奶巧克力');
  assert.equal(p.price, 45.9);
  assert.equal(p.mainImages.length, 6);
  assert.ok(p.mainImages.every((u) => u.startsWith('https://img14.360buyimg.com/sku/jfs/')));
  assert.equal(p.detailImages.length, 13);
  assert.ok(p.detailImages.every((u) => /^https:\/\/img30\.360buyimg\.com\/sku\/jfs\/.+\.(jpg|png)$/.test(u)));
  assert.deepEqual(p.saleDims, [{ name: '规格', values: ['黑巧480g'] }]);
  assert.deepEqual(validateProduct(p), []);
});

test('real item builds a plan against the real chocolate category', () => {
  const settings = mergeSettings({ attrDefaultsText: '本品与最小可售单位数量关系=1\n销售期限=新日期\n产地=中国大陆\n销售单位=桶' });
  const plan = buildPublishPlan({ product: normalizeProduct(raw), edits: {}, settings, schema: chocolateSchema });
  assert.equal(plan.props.values['149365'], 'tz'); // 包装形式=桶装
  assert.equal(plan.props.values['156405'], '364'); // 保质期 364天
  assert.equal(plan.props.values['149371'], 'm'); // 可可脂含量 40%-70%
  assert.deepEqual(plan.sale.dims, [{ name: '规格', values: ['黑巧480g'] }]);
  assert.equal(plan.sale.rows[0].price, 45.9);
  // 源页面没有“净含量/规格”参数，从规格值“黑巧480g”推导
  assert.equal(plan.props.values['156404'], '480g');
  assert.equal(plan.props.values['156403'], '480g');
  assert.deepEqual(plan.blockers, []);
});
