// VC 发布页地址识别 + 设置里的发布平台、VC 默认值
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVcPublishUrl, classifyPageUrl } from '../src/shared/url-utils.js';
import { DEFAULT_SETTINGS, mergeSettings, validateSettings, PUBLISH_PLATFORMS } from '../src/shared/settings.js';

test('buildVcPublishUrl: 带品牌和末级类目直接进入 VC 发布页（不需要 uuid）', () => {
  assert.equal(
    buildVcPublishUrl({ brandId: 17519, categoryId: '31403' }),
    'https://wares-jdm.jd.com/vcProductPublish/?bId=17519&publishPageType=1&locType=0&categoryId=31403',
  );
});

test('buildVcPublishUrl: 缺品牌或类目时报错', () => {
  assert.throws(() => buildVcPublishUrl({ brandId: null, categoryId: '31403' }), /品牌/);
  assert.throws(() => buildVcPublishUrl({ brandId: 17519, categoryId: 'abc' }), /类目/);
});

test('classifyPageUrl: VC 发布页也识别为发布页', () => {
  assert.equal(classifyPageUrl('https://wares-jdm.jd.com/vcProductPublish/?bId=1&categoryId=2&uuid=x'), 'publish');
  assert.equal(classifyPageUrl('https://wares-jdm.jd.com/popPublish/?categoryId=2'), 'publish');
  // VC 账号打开 POP 发布页会被跳回京麦首页
  assert.equal(classifyPageUrl('https://shop.jd.com/jdm/home'), 'other');
});

test('设置：默认发布到 VC 自营，VC 默认值齐全', () => {
  assert.equal(DEFAULT_SETTINGS.publish.platform, 'vc');
  assert.ok('vc' in PUBLISH_PLATFORMS && 'pop' in PUBLISH_PLATFORMS);
  assert.deepEqual(mergeSettings({}).vc, { erpCode: '', saleUnit: '', packSpecification: 1, packType: '普通商品', warranty: '无质保' });
});

test('设置：旧设置没有平台字段时按 VC 处理，已选 POP 的保留', () => {
  assert.equal(validateSettings({ publish: { action: 'submit_on' } }).value.publish.platform, 'vc');
  assert.equal(validateSettings({ publish: { platform: 'pop' } }).value.publish.platform, 'pop');
});

test('设置：VC 字段校验，无效值恢复默认并提示', () => {
  const { value, errors } = validateSettings({
    publish: { platform: 'tmall' },
    vc: { erpCode: ' xudezhi.6 ', saleUnit: ' 箱 ', packSpecification: 0, packType: '危险品', warranty: '' },
  });
  assert.equal(value.publish.platform, 'vc');
  assert.equal(value.vc.erpCode, 'xudezhi.6');
  assert.equal(value.vc.saleUnit, '箱');
  assert.equal(value.vc.packSpecification, 1);
  assert.equal(value.vc.packType, '普通商品');
  assert.equal(value.vc.warranty, '无质保');
  assert.ok(errors.some((e) => /发布平台/.test(e)));
  assert.ok(errors.some((e) => /包装规格/.test(e)));
  assert.ok(errors.some((e) => /商品包装/.test(e)));
});

test('设置：ERP 代码含空格或中文时清空并提示', () => {
  const { value, errors } = validateSettings({ vc: { erpCode: '徐德志 xudezhi' } });
  assert.equal(value.vc.erpCode, '');
  assert.ok(errors.some((e) => /ERP/.test(e)));
});
