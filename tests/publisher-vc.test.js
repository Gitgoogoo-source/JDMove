// VC 自营发布流程（publisher-vc.js）：用假的 chrome.* 和假的页面桥接走完整流程
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { publishVcItem } from '../src/lib/publisher-vc.js';
import { createQueueRunner } from '../src/lib/queue.js';
import { mergeSettings } from '../src/shared/settings.js';

const PRICES = { marketPrice: 89.9, jdPrice: 69.9, costPrice: 50 };

const vcItem = (edits = { vc: { ...PRICES, erpCode: 'xudezhi.6' } }) => ({
  id: '100114866451',
  skuId: '100114866451',
  url: 'https://item.jd.com/100114866451.html',
  status: 'collected',
  message: '',
  log: [],
  target: null,
  createdAt: 1,
  updatedAt: 1,
  edits,
  product: {
    skuId: '100114866451',
    title: '维达（Vinda）抽纸 棉韧3层100抽*36包',
    brand: { id: 17519, name: '维达（Vinda）' },
    crumbs: ['家庭清洁/纸品', '清洁纸品', '抽纸', '常规抽纸'],
    leafCategory: '常规抽纸',
    price: 44.9,
    params: [{ name: '包装形式', value: '箱装' }, { name: '层数', value: '3层' }],
    mainImages: ['https://img14.360buyimg.com/sku/jfs/t1/a.jpg'],
    detailImages: ['https://img30.360buyimg.com/sku/jfs/t1/d1.jpg'],
    saleDims: [{ name: '规格', values: ['【王牌囤货装】 3层 100抽*36包'] }],
    variants: [{ skuId: '100114866451', values: { 规格: '【王牌囤货装】 3层 100抽*36包' } }],
    upc: '6901236326411',
    vc: { cateIds: ['15901', '15902', '15908', '31403'], brandId: 17519, model: 'V2833-D', weightKg: 4.33, lengthMm: 408, widthMm: 310, heightMm: 280, warranty: '无质保' },
  },
});

const makers = {
  main: async (url, name) => ({ name, mime: 'image/jpeg', b64: 'AA==' }),
  detail: async () => [],
  transparent: async (url, name) => ({ name, mime: 'image/png', b64: 'AA==' }),
};

/** VC 发布页桥接的假实现：每个方法默认成功，可按方法名覆盖 */
function vcPage(overrides = {}) {
  const calls = [];
  const replies = {
    vcStatus: { page: 'vc_publish', ready: true },
    getFormSchema: { ok: true, attrs: [], saleDimNames: [], fields: [] },
    vcSetFields: { ok: true, failed: [], skipped: [] },
    vcSetErp: { ok: true, people: ['采购员 徐德志(xudezhi.6)', '销售员 徐德志(xudezhi.6)'], errors: [] },
    setProps: { ok: true, failed: [] },
    vcPutImages: (args) => ({ ok: true, count: (args[0].images ?? []).length + (args[0].names ?? []).length, urls: [], errors: [] }),
    vcRecognize: { ok: true, textFilled: true, errors: [] },
    setDescriptionHtml: { ok: true, length: 100 },
    vcFillSpec: { opened: true, confirmed: true, filled: ['产品描述', '层数', '规格'], missing: [], errors: [] },
    vcSetSkuRow: { ok: true, errors: [], upcNotice: '检测到条形码重复，可正常发品但入仓需贴码，重码商品有' },
    vcFillSkuAttrs: { opened: true, confirmed: true, filled: ['是否印花', '层数'], missing: [], errors: [] },
    vcSkuRowState: { ok: true, skuName: '抽纸 棉韧3层100抽*36包 王牌囤货装' },
    vcValidate: { ok: true, errors: [] },
    vcPayloadCheck: { ok: true, problems: [], floats: [] },
    runAction: { ok: true, messages: ['提交成功'], errors: [], wareIds: [] },
    ...overrides,
  };
  const backend = (method, args) => {
    calls.push({ method, args });
    const reply = replies[method];
    return (typeof reply === 'function' ? reply(args) : reply) ?? { ok: true };
  };
  return { calls, methods: () => calls.map((c) => c.method), backend };
}

// actionVersion: 2 —— 没有版本号的旧设置会把“保存草稿”迁移成“提交并上架”
const settings = (publish = {}) =>
  mergeSettings({ publish: { platform: 'vc', reuploadDetailImages: false, action: 'none', actionVersion: 2, ...publish } });

test('publishVcItem: 3 个价格没填时不打开发布页，标为需处理', async () => {
  const page = vcPage();
  const fake = installFakeChrome({ backend: page.backend });
  const res = await publishVcItem(vcItem({}), settings(), () => {}, { imageMakers: makers });
  assert.equal(res.status, 'need_action');
  assert.match(res.message, /市场价、京东价、采购价/);
  assert.ok(!fake.ops().includes('tabs.create'));
});

test('publishVcItem: 直接打开带品牌和末级类目的 VC 发布页，按顺序填完；“只填写”时停在页面', async () => {
  const page = vcPage();
  const fake = installFakeChrome({ backend: page.backend });
  const lines = [];
  const res = await publishVcItem(vcItem(), settings(), (l) => lines.push(l), { imageMakers: makers });
  assert.equal(res.status, 'filled', `${res.message}\n${lines.join('\n')}`);
  assert.ok(res.tabId, '保留发布页供检查');
  const opened = fake.calls.find((c) => c.op === 'tabs.create').url;
  assert.equal(opened, 'https://wares-jdm.jd.com/vcProductPublish/?bId=17519&publishPageType=1&locType=0&categoryId=31403');
  const order = [...new Set(page.methods())];
  assert.deepEqual(order, [
    'vcStatus', 'getFormSchema', 'vcSetFields', 'vcSetErp', 'setProps', 'vcPutImages', 'vcRecognize', 'setDescriptionHtml',
    'vcFillSpec', 'vcSetSkuRow', 'vcFillSkuAttrs', 'vcSkuRowState', 'vcValidate', 'vcPayloadCheck',
  ]);
  assert.ok(!page.methods().includes('runAction'), '只填写不保存');
  const images = page.calls.filter((c) => c.method === 'vcPutImages').map((c) => c.args[0].field);
  assert.deepEqual(images, ['imageList', 'transparentImageList', 'aiRecImages']);
  const rec = page.calls.find((c) => c.method === 'vcPutImages' && c.args[0].field === 'aiRecImages').args[0];
  const main = page.calls.find((c) => c.method === 'vcPutImages' && c.args[0].field === 'imageList').args[0];
  assert.deepEqual(rec.names, [main.images[0].name], '图片信息识别勾选刚传的第一张主图');
  assert.match(main.images[0].name, /^jdmove_vc_100114866451_\d+_m0\.jpg$/);
  const recognize = page.calls.find((c) => c.method === 'vcRecognize').args[0];
  assert.ok(recognize.text && !/维达/.test(recognize.text), '识别文案用发布标题（不带品牌）');
  assert.ok(page.methods().indexOf('vcRecognize') > page.methods().lastIndexOf('vcPutImages'), '图片都放好之后再识别');
  const erp = page.calls.find((c) => c.method === 'vcSetErp');
  assert.deepEqual(erp.args, ['xudezhi.6']);
  assert.ok(lines.some((l) => /入仓需贴码/.test(l)), '重码提示写进日志');
});

test('publishVcItem: 没填 ERP 时不改采购员/销售员，沿用页面默认值并提醒', async () => {
  const page = vcPage();
  installFakeChrome({ backend: page.backend });
  const lines = [];
  const res = await publishVcItem(vcItem({ vc: PRICES }), settings(), (l) => lines.push(l), { imageMakers: makers });
  assert.equal(res.status, 'filled');
  assert.ok(!page.methods().includes('vcSetErp'));
  assert.ok(lines.some((l) => /ERP 没有填写/.test(l)));
});

test('publishVcItem: 设置为提交并上架时也只点“保存草稿”，成功后记下京东价', async () => {
  const page = vcPage();
  installFakeChrome({ backend: page.backend });
  const lines = [];
  const res = await publishVcItem(vcItem(), settings({ action: 'submit_on' }), (l) => lines.push(l), { imageMakers: makers });
  assert.equal(res.status, 'published', res.message);
  assert.equal(res.price, 69.9);
  assert.deepEqual(page.calls.find((c) => c.method === 'runAction').args, ['vc_draft']);
  assert.ok(lines.some((l) => /已保存草稿/.test(l)));
});

test('publishVcItem: 字段一律按字符串写入（毛重 4.33 写 "4.33"，数字会被保存接口拒收 [456]）', async () => {
  const page = vcPage();
  installFakeChrome({ backend: page.backend });
  await publishVcItem(vcItem(), settings({ action: 'draft' }), () => {}, { imageMakers: makers });
  const { entries } = page.calls.find((c) => c.method === 'vcSetFields').args[0];
  assert.ok(entries.every((e) => typeof e.value === 'string'), JSON.stringify(entries));
  const value = (field) => entries.find((e) => e.field === field)?.value;
  assert.equal(value('weight'), '4.33');
  assert.equal(value('length'), '408');
  assert.equal(value('marketPrice'), '89.9');
  assert.equal(value('features.model'), 'V2833-D');
  const checked = page.calls.find((c) => c.method === 'vcPayloadCheck').args[0].fields.map((f) => f.field);
  assert.ok(checked.includes('weight') && checked.includes('marketPrice'), '保存前检查写过的字段');
});

test('publishVcItem: 提交数据里字段不是文本时不保存，保留页面并说明', async () => {
  const page = vcPage({ vcPayloadCheck: { ok: false, problems: ['毛重=4.33（数字）'], floats: ['weight=4.33'] } });
  installFakeChrome({ backend: page.backend });
  const res = await publishVcItem(vcItem(), settings({ action: 'draft' }), () => {}, { imageMakers: makers });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /毛重=4\.33（数字）/);
  assert.ok(res.tabId);
  assert.ok(!page.methods().includes('runAction'));
});

test('publishVcItem: 保存草稿接口返回 [456] 时标为失败并带出页面原文', async () => {
  const page = vcPage({ runAction: { ok: false, messages: ['保存草稿失败：无效的字符串，请核对后再试 [456]'], errors: [], wareIds: [] } });
  installFakeChrome({ backend: page.backend });
  const res = await publishVcItem(vcItem(), settings({ action: 'draft' }), () => {}, { imageMakers: makers });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /\[456\]/);
});

test('publishVcItem: 保存草稿成功时记下草稿编号', async () => {
  const page = vcPage({ runAction: { ok: true, messages: ['草稿已保存'], errors: [], wareIds: [], draftId: '414309950' } });
  installFakeChrome({ backend: page.backend });
  const lines = [];
  const res = await publishVcItem(vcItem(), settings({ action: 'draft' }), (l) => lines.push(l), { imageMakers: makers });
  assert.equal(res.status, 'published');
  assert.ok(lines.some((l) => /草稿编号 414309950/.test(l)));
});

test('publishVcItem: 保存草稿 → 点“保存草稿”', async () => {
  const page = vcPage();
  installFakeChrome({ backend: page.backend });
  await publishVcItem(vcItem(), settings({ action: 'draft' }), () => {}, { imageMakers: makers });
  assert.deepEqual(page.calls.find((c) => c.method === 'runAction').args, ['vc_draft']);
});

test('publishVcItem: 页面本地校验没通过时不提交，保留页面并写出原因', async () => {
  const page = vcPage({ vcValidate: { ok: false, errors: ['图片信息识别：请先上传图片'] } });
  installFakeChrome({ backend: page.backend });
  const res = await publishVcItem(vcItem(), settings({ action: 'submit_on' }), () => {}, { imageMakers: makers });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /图片信息识别：请先上传图片/);
  assert.ok(res.tabId);
  assert.ok(!page.methods().includes('runAction'));
});

test('publishVcItem: 图片信息识别没完成时标为需处理，不再往下填，保留页面', async () => {
  const page = vcPage({ vcRecognize: { ok: false, errors: ['识别没有成功', '系统繁忙'] } });
  installFakeChrome({ backend: page.backend });
  const res = await publishVcItem(vcItem(), settings({ action: 'submit_on' }), () => {}, { imageMakers: makers });
  assert.equal(res.status, 'need_action');
  assert.match(res.message, /图片信息识别没有完成（识别没有成功；系统繁忙）/);
  assert.match(res.message, /开始识别/);
  assert.ok(res.tabId);
  assert.ok(!page.methods().includes('setDescriptionHtml'));
  assert.ok(!page.methods().includes('runAction'));
});

test('publishVcItem: 页面已经识别过时不写日志、继续往下填', async () => {
  const page = vcPage({ vcRecognize: { ok: true, already: true, errors: [] } });
  installFakeChrome({ backend: page.backend });
  const lines = [];
  const res = await publishVcItem(vcItem(), settings(), (l) => lines.push(l), { imageMakers: makers });
  assert.equal(res.status, 'filled', res.message);
  assert.ok(!lines.some((l) => /图片信息识别：已识别/.test(l)));
});

test('publishVcItem: 价格没写进去时停止，不再往下填', async () => {
  const page = vcPage({ vcSetFields: { ok: false, failed: ['京东价'], skipped: [] } });
  installFakeChrome({ backend: page.backend });
  const res = await publishVcItem(vcItem(), settings(), () => {}, { imageMakers: makers });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /京东价/);
  assert.ok(!page.methods().includes('vcPutImages'));
});

test('publishVcItem: ERP 找不到时标为需处理并保留页面', async () => {
  const page = vcPage({ vcSetErp: { ok: false, people: [], errors: ['采购员：没有找到 ERP“nobody”'] } });
  installFakeChrome({ backend: page.backend });
  const res = await publishVcItem(vcItem({ vc: { ...PRICES, erpCode: 'nobody' } }), settings(), () => {}, { imageMakers: makers });
  assert.equal(res.status, 'need_action');
  assert.match(res.message, /nobody/);
  assert.ok(res.tabId);
});

test('publishVcItem: 规格抽屉没填好只记日志继续；SKU属性没填好标为需处理', async () => {
  const page = vcPage({
    vcFillSpec: { opened: true, confirmed: false, filled: [], missing: ['层数'], errors: [] },
    vcFillSkuAttrs: { opened: true, confirmed: false, filled: ['层数'], missing: ['纸张尺寸'], errors: [] },
  });
  installFakeChrome({ backend: page.backend });
  const lines = [];
  const res = await publishVcItem(vcItem(), settings(), (l) => lines.push(l), { imageMakers: makers });
  assert.ok(lines.some((l) => /规格没有填好.*层数/.test(l)), lines.join('\n'));
  assert.equal(res.status, 'need_action');
  assert.match(res.message, /纸张尺寸/);
  assert.ok(!page.methods().includes('vcValidate'));
});

test('publishVcItem: 透图生成失败时提示手动上传', async () => {
  const page = vcPage();
  installFakeChrome({ backend: page.backend });
  const broken = { ...makers, transparent: async () => { throw new Error('图片下载失败 403'); } };
  const lines = [];
  const res = await publishVcItem(vcItem(), settings(), (l) => lines.push(l), { imageMakers: broken });
  assert.equal(res.status, 'need_action');
  assert.match(res.message, /透图/);
  assert.ok(lines.some((l) => /透图生成失败：图片下载失败 403/.test(l)));
});

test('publishVcItem: 品牌未授权等原因被跳回京麦首页时，说明原因并关闭页面', async () => {
  const page = vcPage();
  const fake = installFakeChrome({ backend: page.backend, resolveUrl: () => 'https://shop.jd.com/jdm/home' });
  const res = await publishVcItem(vcItem(), settings(), () => {}, { imageMakers: makers });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /VC 发布页没有打开/);
  assert.ok(fake.ops().includes('tabs.remove'));
});

test('发布队列：设置为 VC 自营时走 VC 发布流程', async () => {
  const page = vcPage();
  const fake = installFakeChrome({ backend: page.backend });
  Object.assign(fake.localStore, { items: [vcItem({ vc: PRICES })], settings: { publish: { platform: 'vc', action: 'none', reuploadDetailImages: false } } });
  const logs = [];
  const runner = createQueueRunner({ onChange: () => {}, onLog: (l) => logs.push(l) });
  await runner.publish(['100114866451']);
  assert.ok(page.methods().includes('vcStatus'), page.methods().join(','));
  assert.ok(logs.some((l) => /^发布到：VC 自营/.test(l)), '日志写明发布平台');
  assert.ok(!page.methods().includes('selectBrand'));
});
