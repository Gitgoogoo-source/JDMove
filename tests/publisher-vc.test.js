// VC 自营发布流程（publisher-vc.js）：用假的 chrome.* 和假的页面桥接走完整流程
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { publishVcItem } from '../src/lib/publisher-vc.js';
import { createQueueRunner } from '../src/lib/queue.js';
import { mergeSettings } from '../src/shared/settings.js';
import { CATEGORY_PAGE } from '../src/lib/category-search.js';
import { CHOUZHI_CHILDREN, ROLL_CHILDREN } from './fixtures/vc-categories.js';

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
    getFormSchema: { ok: true, attrs: [], fields: [] },
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
    runAction: { ok: true, messages: ['提交成功'], errors: [] },
    ...overrides,
  };
  const backend = (method, args) => {
    calls.push({ method, args });
    const reply = replies[method];
    return (typeof reply === 'function' ? reply(args) : reply) ?? { ok: true };
  };
  return { calls, methods: () => calls.map((c) => c.method), backend };
}

/**
 * 商品审核列表 / 落地页的假页面：按注入的函数分别返回。
 * records：组件数据（null = 读不到组件，退回读文字）；texts：每行文字；mark：sessionStorage 里发布页存下的结果
 */
function listPage({ records = null, texts = [], mark = null } = {}) {
  const at = (v) => (typeof v === 'function' ? v() : v);
  return ({ func, args }) => {
    if (func.name === 'readApplyRecordsInPage') return at(records);
    if (func.name === 'readApplyRowsInPage') return at(texts);
    if (func.name === 'readPublishMarkInPage') return mark && mark.nonce === undefined ? { ...mark, nonce: args[0] } : mark;
    return undefined;
  };
}

const settings = (publish = {}) => mergeSettings({ publish: { reuploadDetailImages: false, action: 'none', ...publish } });

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
  assert.deepEqual(erp.args, [{ buyer: 'xudezhi.6', saler: 'xudezhi.6' }]);
  assert.ok(lines.some((l) => /入仓需贴码/.test(l)), '重码提示写进日志');
});

test('publishVcItem: 按本地主图顺序上传，单独上传已有透图，识别用本地首图', async () => {
  const page = vcPage();
  installFakeChrome({ backend: page.backend });
  const dir = '大公鸡管家/100114866451/主图';
  const sendLocal = (mime) => async (url, name) => {
    assert.match(url, /^blob:/);
    const file = await (await fetch(url)).blob();
    return { name, mime, b64: Buffer.from(await file.arrayBuffer()).toString('base64') };
  };
  const lines = [];
  const res = await publishVcItem(vcItem(), settings(), (line) => lines.push(line), {
    readLocalImages: async () => ({
      main: ['front', 'back'].map((text) => new Blob([text], { type: 'image/jpeg' })),
      transparent: new Blob(['cutout'], { type: 'image/png' }),
      dir,
    }),
    imageMakers: {
      main: sendLocal('image/jpeg'),
      transparent: () => assert.fail('不应重新生成透图'),
      localTransparent: sendLocal('image/png'),
    },
  });
  assert.equal(res.status, 'filled', res.message);
  const [mains, png, recognition] = page.calls.filter((c) => c.method === 'vcPutImages').map((c) => c.args[0]);
  assert.deepEqual(mains.images.map((image) => Buffer.from(image.b64, 'base64').toString()), ['front', 'back']);
  assert.equal(Buffer.from(png.images[0].b64, 'base64').toString(), 'cutout');
  assert.deepEqual(recognition.names, [mains.images[0].name]);
  assert.ok(lines.some((line) => line.includes(dir)));
});

test('publishVcItem: 本地主图目录为空时拦下，采集图不会补位', async () => {
  const fake = installFakeChrome({ backend: vcPage().backend });
  const res = await publishVcItem(vcItem(), settings(), () => {}, {
    readLocalImages: async () => ({ main: [], transparent: null, dir: '品牌/100114866451/主图' }),
    imageMakers: makers,
  });
  assert.equal(res.status, 'need_action');
  assert.match(res.message, /本地主图目录没有可用/);
  assert.ok(!fake.ops().includes('tabs.create'));
});

test('publishVcItem: 详情图转存到图片空间后按顺序写进商品详情（每次最多传 6 张）', async () => {
  let n = 0;
  const page = vcPage({ uploadDetailImages: (args) => ({ ok: true, urls: args[0].map(() => `jfs/t1/d${(n += 1)}.jpg`), errors: [] }) });
  installFakeChrome({ backend: page.backend });
  const slices = Array.from({ length: 8 }, (_, i) => ({ name: `d${i}.jpg`, mime: 'image/jpeg', b64: 'AA==' }));
  const lines = [];
  const res = await publishVcItem(vcItem(), settings({ reuploadDetailImages: true }), (l) => lines.push(l), {
    imageMakers: { ...makers, detail: async () => slices },
  });
  assert.equal(res.status, 'filled', res.message);
  const batches = page.calls.filter((c) => c.method === 'uploadDetailImages').map((c) => c.args[0].length);
  assert.deepEqual(batches, [6, 2]);
  const html = page.calls.find((c) => c.method === 'setDescriptionHtml').args[0];
  assert.ok(html.indexOf('imgzone/jfs/t1/d1.jpg') < html.indexOf('imgzone/jfs/t1/d8.jpg'), html);
  assert.ok(lines.some((l) => /详情图已转存 8 张/.test(l)));
});

test('publishVcItem: 详情图转存失败时标为失败并保留页面', async () => {
  const page = vcPage({ uploadDetailImages: { ok: false, error: '图片空间未打开', urls: [], errors: [] } });
  installFakeChrome({ backend: page.backend });
  const res = await publishVcItem(vcItem(), settings({ reuploadDetailImages: true }), () => {}, {
    imageMakers: { ...makers, detail: async () => [{ name: 'd0.jpg', mime: 'image/jpeg', b64: 'AA==' }] },
  });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /图片空间未打开/);
  assert.ok(res.tabId);
  assert.ok(!page.methods().includes('setDescriptionHtml'));
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

test('publishVcItem: 旧设置里的“提交并上架”也点“发布商品”，成功后带回填进页面的标题、品牌名、价格、条形码（写上架总表用）', async () => {
  const page = vcPage({ vcPayloadCheck: { ok: true, problems: [], floats: [], brandTitle: '维达' }, runAction: { ok: true, messages: ['商品已发布'], errors: [], skuIds: ['100200300401'] } });
  installFakeChrome({ backend: page.backend });
  const lines = [];
  const item = vcItem({ title: '棉韧抽纸 3层100抽*36包', vc: { ...PRICES, erpCode: 'xudezhi.6' } });
  const res = await publishVcItem(item, settings({ action: 'submit_on' }), (l) => lines.push(l), { imageMakers: makers });
  assert.equal(res.status, 'published', res.message);
  assert.deepEqual(res.listing, { title: '棉韧抽纸 3层100抽*36包', brandTitle: '维达', prices: PRICES, upc: '6901236326411' });
  const [action, opts] = page.calls.find((c) => c.method === 'runAction').args;
  assert.equal(action, 'vc_publish');
  assert.match(opts.nonce, /\S/, '带上这次发布的 nonce');
  assert.ok(lines.some((l) => /已发布/.test(l)));
});

test('publishVcItem: 字段一律按字符串写入（毛重 4.33 写 "4.33"，数字会被保存接口拒收 [456]）', async () => {
  const page = vcPage();
  installFakeChrome({ backend: page.backend });
  await publishVcItem(vcItem(), settings({ action: 'publish' }), () => {}, { imageMakers: makers });
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
  const res = await publishVcItem(vcItem(), settings({ action: 'publish' }), () => {}, { imageMakers: makers });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /毛重=4\.33（数字）/);
  assert.ok(res.tabId);
  assert.ok(!page.methods().includes('runAction'));
});

test('publishVcItem: 发布接口返回 [456] 时标为失败并带出页面原文', async () => {
  const page = vcPage({ runAction: { ok: false, messages: ['发布商品失败：无效的字符串，请核对后再试 [456]'], errors: [] } });
  installFakeChrome({ backend: page.backend });
  const res = await publishVcItem(vcItem(), settings({ action: 'publish' }), () => {}, { imageMakers: makers });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /\[456\]/);
});

test('publishVcItem: 发布成功时带回京东分配的 SKU 并写进日志', async () => {
  const page = vcPage({ runAction: { ok: true, messages: ['商品已发布（SKU 100200300401）'], errors: [], skuIds: ['100200300401'], productId: '10023456789', applyId: '5566778' } });
  installFakeChrome({ backend: page.backend });
  const lines = [];
  const res = await publishVcItem(vcItem(), settings({ action: 'publish' }), (l) => lines.push(l), { imageMakers: makers });
  assert.equal(res.status, 'published');
  assert.deepEqual(res.skuIds, ['100200300401']);
  assert.equal(res.productId, '10023456789');
  assert.equal(res.applyId, '5566778');
  assert.ok(lines.some((l) => /京东分配的 SKU：100200300401/.test(l)));
});

test('publishVcItem: 发布 → 点“发布商品”；接口没返回 SKU、商品审核列表里也找不到时仍算发布成功并提醒', async () => {
  const page = vcPage();
  const fake = installFakeChrome({ backend: page.backend, page: listPage({ records: [] }) });
  const lines = [];
  const res = await publishVcItem(vcItem(), settings({ action: 'publish' }), (l) => lines.push(l), { imageMakers: makers, applyRetryMs: 1 });
  assert.equal(page.calls.find((c) => c.method === 'runAction').args[0], 'vc_publish');
  assert.equal(res.status, 'published');
  assert.deepEqual(res.skuIds, []);
  assert.ok(lines.some((l) => /发布接口不返回 SKU，没拿到申请单号/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /商品审核列表里没找到/.test(l)), lines.join('\n'));
  assert.ok(fake.calls.some((c) => c.op === 'tabs.update' && /activeTab=ApplyWare/.test(c.url)), '打开了商品审核列表');
  assert.equal(lines.filter((l) => /秒后刷新再找/.test(l)).length, 2, '没找到时刷新列表重找');
  assert.equal(fake.calls.filter((c) => c.op === 'tabs.update' && /activeTab=ApplyWare/.test(c.url)).length, 3);
});

test('publishVcItem: 接口没返回 SKU 时到商品审核列表按名称和提交时间找回（名称=品牌名+标题）', async () => {
  const page = vcPage({ vcPayloadCheck: { ok: true, problems: [], floats: [], brandTitle: '维达' } });
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const rows = [
    `维达棉韧抽纸 3层100抽*36包\n商品编码: 100448634314\n提交: ${stamp}\n审核中`,
    '维达棉韧抽纸 3层100抽*36包\n商品编码: 100400000001\n提交: 2026-11-09 17:21:58\n审核通过',
    `别的商品\n商品编码: 100400000002\n提交: ${stamp}`,
  ];
  installFakeChrome({ backend: page.backend, page: listPage({ texts: rows }) });
  const lines = [];
  const item = vcItem({ title: '棉韧抽纸 3层100抽*36包', vc: { ...PRICES, erpCode: 'xudezhi.6' } });
  const res = await publishVcItem(item, settings({ action: 'publish' }), (l) => lines.push(l), { imageMakers: makers });
  assert.equal(res.status, 'published');
  assert.deepEqual(res.skuIds, ['100448634314']);
  assert.ok(lines.some((l) => /在商品审核列表里找到了 SKU 100448634314/.test(l)));
});

test('publishVcItem: 同名商品连发时，商品审核列表里已经记进上架总表的 SKU 不再拿，刷新到新提交的那条', async () => {
  const page = vcPage({ vcPayloadCheck: { ok: true, problems: [], floats: [], brandTitle: '维达' } });
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const earlier = `维达棉韧抽纸 3层100抽*36包\n商品编码: 100448634314\n提交: ${stamp}\n审核中`;
  const fresh = `维达棉韧抽纸 3层100抽*36包\n商品编码: 100448634999\n提交: ${stamp}\n审核中`;
  let reads = 0;
  // 第一次读列表：新提交的还没出来，只有上一次发布的；刷新后才有新的
  installFakeChrome({ backend: page.backend, page: listPage({ texts: () => (++reads === 1 ? [earlier] : [fresh, earlier]) }) });
  await chrome.storage.local.set({ masterRecords: [{ id: '100448634314-1', sku: '100448634314', name: '维达棉韧抽纸 3层100抽*36包' }] });
  const lines = [];
  const item = vcItem({ title: '棉韧抽纸 3层100抽*36包', vc: { ...PRICES, erpCode: 'xudezhi.6' } });
  const res = await publishVcItem(item, settings({ action: 'publish' }), (l) => lines.push(l), { imageMakers: makers, applyRetryMs: 1 });
  assert.equal(res.status, 'published');
  assert.deepEqual(res.skuIds, ['100448634999']);
  assert.ok(lines.some((l) => /秒后刷新再找/.test(l)), lines.join('\n'));
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

test('publishVcItem: 采购员和销售员 ERP 不同时分别传给页面', async () => {
  const page = vcPage();
  installFakeChrome({ backend: page.backend });
  const res = await publishVcItem(vcItem({ vc: { ...PRICES, buyerErp: 'caigou.1', salerErp: 'xiaoshou.2' } }), settings(), () => {}, { imageMakers: makers });
  assert.equal(res.status, 'filled');
  assert.deepEqual(page.calls.find((c) => c.method === 'vcSetErp').args, [{ buyer: 'caigou.1', saler: 'xiaoshou.2' }]);
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

test('发布队列：旧设置里选的是 POP 店铺也走 VC 发布流程', async () => {
  const page = vcPage();
  const fake = installFakeChrome({ backend: page.backend });
  Object.assign(fake.localStore, { items: [vcItem({ vc: PRICES })], settings: { publish: { platform: 'pop', action: 'none', reuploadDetailImages: false } } });
  const runner = createQueueRunner({ onChange: () => {}, onLog: () => {} });
  await runner.publish(['100114866451']);
  assert.ok(page.methods().includes('vcStatus'), page.methods().join(','));
});

// ---------- 源类目不是末级类目（SKU 10077221167161：主数据里只有三级 15901 > 15902 > 15908） ----------
const vcUrl = (categoryId) => `https://wares-jdm.jd.com/vcProductPublish/?bId=17519&publishPageType=1&locType=0&categoryId=${categoryId}`;
const NOT_LEAF = { page: 'vc_publish', ready: false, notLeaf: true, pageError: '您选择的类目不是末级类目' };

/** 老商品：类目还挂在三级“抽纸”上，标题末尾堆了“擦手纸” */
function threeLevelItem(skuId = '10077221167161') {
  const item = vcItem();
  return {
    ...item,
    id: skuId,
    skuId,
    product: {
      ...item.product,
      skuId,
      title: '维达（Vinda）抽纸 硬盒盒装抽纸 精品面巾纸卫生纸巾加厚3层100抽餐巾纸擦手纸 自然无香8盒2提装',
      crumbs: ['家庭清洁/纸品', '清洁纸品', '抽纸', '维达（Vinda）'],
      leafCategory: '抽纸',
      vc: { ...item.product.vc, cateIds: ['15901', '15902', '15908'] },
    },
  };
}

/** 按标签页当前地址回答 vcStatus：categoryId=15908 是“不是末级类目”的错误页 */
function leafAwarePage(overrides = {}, fakeOpts = {}) {
  let fake;
  const currentUrl = () => [...fake.tabs.values()].at(-1)?.url ?? '';
  const page = vcPage({
    vcStatus: () => (/categoryId=15908(?:&|$)/.test(currentUrl()) ? NOT_LEAF : { page: 'vc_publish', ready: true }),
    vcChildCategories: { ok: true, leaf: false, children: CHOUZHI_CHILDREN },
    ...overrides,
  });
  fake = installFakeChrome({ backend: page.backend, ...fakeOpts });
  const navUrls = () => fake.calls.filter((c) => c.op === 'tabs.create' || c.op === 'tabs.update').map((c) => c.url);
  return { page, fake, navUrls };
}

test('publishVcItem: 源类目不是末级类目时到类目页选子类目，改用末级类目重新打开发布页并填完', async () => {
  const { page, navUrls } = leafAwarePage();
  const lines = [];
  const res = await publishVcItem(threeLevelItem(), settings(), (l) => lines.push(l), { imageMakers: makers, leafCache: new Map() });
  assert.equal(res.status, 'filled', `${res.message}\n${lines.join('\n')}`);
  assert.equal(res.target.categoryId, '31403');
  assert.deepEqual(res.target.cateList, ['15901', '15902', '15908', '31403']);
  assert.match(res.message, /类目已自动改为「抽纸 > 常规抽纸」\[31403\]/, '结果里也写明换了类目');
  assert.deepEqual(navUrls(), [vcUrl(15908), CATEGORY_PAGE, vcUrl(31403)]);
  assert.deepEqual(page.calls.find((c) => c.method === 'vcChildCategories').args, [{ path: ['15901', '15902', '15908'] }]);
  assert.ok(lines.some((l) => /抽纸.*15908.*不是末级类目.*常规抽纸.*31403/.test(l)), lines.join('\n'));
  assert.ok(page.methods().includes('vcValidate'), '换成末级类目后照常填写');
});

test('publishVcItem: 同一个非末级类目第二次直接用记下的子类目，不再打开错误的发布页和类目页', async () => {
  const { page, fake, navUrls } = leafAwarePage();
  const leafCache = new Map();
  await publishVcItem(threeLevelItem('10077221167161'), settings(), () => {}, { imageMakers: makers, leafCache });
  const before = navUrls().length;
  const lines = [];
  const res = await publishVcItem(threeLevelItem('10077221167162'), settings(), (l) => lines.push(l), { imageMakers: makers, leafCache });
  assert.equal(res.status, 'filled', res.message);
  assert.deepEqual(navUrls().slice(before), [vcUrl(31403)]);
  assert.equal(page.methods().filter((m) => m === 'vcChildCategories').length, 1);
  assert.equal(lines.filter((l) => /已改用子类目/.test(l)).length, 1, '用缓存时也写明选了哪个子类目，只写一次');
  assert.match(res.message, /31403/);
  assert.ok(fake.ops().includes('tabs.create'));
});

test('publishVcItem: 子类目判断不出来时标为需处理，列出候选类目ID，关闭页面', async () => {
  const { page, fake } = leafAwarePage({ vcChildCategories: { ok: true, leaf: false, children: ROLL_CHILDREN } });
  const res = await publishVcItem(threeLevelItem(), settings(), () => {}, { imageMakers: makers, leafCache: new Map() });
  assert.equal(res.status, 'need_action');
  assert.match(res.message, /不是末级类目/);
  assert.match(res.message, /大盘纸\[44477\]、有芯卷纸\[40883\]、无芯卷纸\[40884\]/);
  assert.match(res.message, /15901,15902,15908,44477/, '给出可以直接填的类目ID路径示例');
  assert.ok(!page.methods().includes('getFormSchema'));
  assert.ok(fake.ops().includes('tabs.remove'));
});

test('publishVcItem: 类目页读不到子类目时标为需处理并带出原因', async () => {
  const { page } = leafAwarePage({ vcChildCategories: { ok: false, error: '类目选择页第 1 级里没有类目 15901', children: [] } });
  const res = await publishVcItem(threeLevelItem(), settings(), () => {}, { imageMakers: makers, leafCache: new Map() });
  assert.equal(res.status, 'need_action');
  assert.match(res.message, /第 1 级里没有类目 15901/);
  assert.match(res.message, /编辑/);
  assert.ok(!page.methods().includes('getFormSchema'));
});

test('publishVcItem: 发布页显示其他错误时马上带出页面原文，不等 40 秒', async () => {
  const page = vcPage({ vcStatus: { page: 'vc_publish', ready: false, pageError: '该品牌未授权' } });
  installFakeChrome({ backend: page.backend });
  const started = Date.now();
  const res = await publishVcItem(vcItem(), settings(), () => {}, { imageMakers: makers, leafCache: new Map() });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /该品牌未授权/);
  assert.ok(Date.now() - started < 10000);
  assert.equal(page.methods().filter((m) => m === 'vcStatus').length, 1);
});

test('publishVcItem: 自动选的子类目仍被发布页拒绝时标为失败、写明是哪个，并清掉记下的子类目', async () => {
  const { page } = leafAwarePage({ vcStatus: NOT_LEAF });
  const leafCache = new Map();
  const res = await publishVcItem(threeLevelItem(), settings(), () => {}, { imageMakers: makers, leafCache });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /常规抽纸」\[31403\] 在 VC 发布页上仍提示不是末级类目/);
  assert.equal(res.notLeaf, undefined);
  assert.ok(!leafCache.has('15908'), '下次重新读子类目');
  assert.ok(!page.methods().includes('getFormSchema'));
});

test('publishVcItem: 类目页要求登录时标为需处理', async () => {
  const toLogin = (u) => (/categorySelect/.test(u) ? 'https://passport.jd.com/new/login.aspx' : u);
  const { page, fake } = leafAwarePage({}, { resolveUrl: toLogin });
  const res = await publishVcItem(threeLevelItem(), settings(), () => {}, { imageMakers: makers, leafCache: new Map() });
  assert.equal(res.status, 'need_action');
  assert.match(res.message, /重新登录/);
  assert.ok(fake.ops().includes('tabs.remove'));
  assert.ok(!page.methods().includes('vcChildCategories'));
});

test('publishVcItem: 按类目路径读上架模板写进日志；超出模板里该类目的上限时不打开发布页', async () => {
  const page = vcPage();
  const fake = installFakeChrome({ backend: page.backend });
  const lines = [];
  const asked = [];
  const template = {
    categoryName: '抽纸',
    path: [{ name: '家庭清洁/纸品' }, { name: '清洁纸品' }, { name: '抽纸' }],
    capturedAt: '2026-11-09T00:00:00.000Z',
    baseFields: [{ field: 'length', min: 1, max: 400 }],
    productProps: [],
  };
  const loadTemplate = async (cateList) => (asked.push(cateList), template);
  const res = await publishVcItem(vcItem(), settings(), (l) => lines.push(l), { imageMakers: makers, loadTemplate });
  assert.deepEqual(asked, [['15901', '15902', '15908', '31403']]);
  assert.ok(lines.includes('上架模板：家庭清洁/纸品 > 清洁纸品 > 抽纸（2026-11-09 录制）'));
  assert.equal(res.status, 'need_action');
  assert.match(res.message, /长“408”超出页面允许的范围（1~400mm/);
  assert.ok(!fake.ops().includes('tabs.create'));
});

test('publishVcItem: 发布后页面整页跳走、脚本没来得及返回时，按落地地址判断（申请中列表 / publish-success?wareId=）', async () => {
  for (const [landing, productId] of [
    ['https://wares-jdm.jd.com/ware/wareList?businessModel=1&activeTab=ApplyWare', ''],
    ['https://wares-jdm.jd.com/ware/publish-success?wareId=10023456789&applyId=5566778&categoryId=31403', '10023456789'],
  ]) {
    let fake;
    const page = vcPage({
      runAction: () => {
        for (const [id, tab] of fake.tabs) fake.tabs.set(id, { ...tab, url: landing });
        return {}; // 页面跳走，脚本被打断，没有结果
      },
    });
    fake = installFakeChrome({ backend: page.backend });
    const lines = [];
    const res = await publishVcItem(vcItem(), settings({ action: 'publish' }), (l) => lines.push(l), { imageMakers: makers, landTimeoutMs: 500, applyRetryMs: 1 });
    assert.equal(res.status, 'published', res.message);
    assert.equal(res.productId, productId);
    assert.deepEqual(res.skuIds, []);
    assert.match(res.message, productId ? /申请单 5566778，SKU 待从商品审核列表取回/ : /没拿到申请单号/);
  }
});

// ---- 按申请单号找 SKU（2026-11-20 实测：发布接口只返回 applyId，SKU 要到商品审核列表按 applyId 对） ----
const SAME_NAME = '维达棉韧抽纸 3层100抽*36包';
const applyRecord = (applyId, productId, created = Date.now()) => ({ applyId, productId, productName: SAME_NAME, created });
const namedItem = () => vcItem({ title: '棉韧抽纸 3层100抽*36包', vc: { ...PRICES, erpCode: 'xudezhi.6' } });
const namedPage = (runAction) => vcPage({ vcPayloadCheck: { ok: true, problems: [], floats: [], brandTitle: '维达' }, runAction });
const APPLY_OK = { ok: true, messages: ['商品已发布（申请单 new-apply，SKU 待从商品审核列表取回）'], errors: [], skuIds: [], applyId: 'new-apply', serverTime: Date.now() };

test('publishVcItem: 同名商品连发、新提交的还没进列表时，不拿上一次的 SKU；刷新后按申请单号对上新的', async () => {
  const page = namedPage(APPLY_OK);
  const earlier = applyRecord('old-apply', 100448634314, Date.now() - 30e3);
  let reads = 0;
  installFakeChrome({ backend: page.backend, page: listPage({ records: () => (++reads === 1 ? [earlier] : [applyRecord('new-apply', 100448634999), earlier]) }) });
  const lines = [];
  const res = await publishVcItem(namedItem(), settings({ action: 'publish' }), (l) => lines.push(l), { imageMakers: makers, applyRetryMs: 1 });
  assert.equal(res.status, 'published');
  assert.deepEqual(res.skuIds, ['100448634999']);
  assert.equal(res.applyId, 'new-apply');
  assert.ok(lines.some((l) => /找到了 SKU 100448634999（按申请单 new-apply）/.test(l)), lines.join('\n'));
  assert.equal(res.message, '商品已发布（申请单 new-apply，SKU 100448634999）');
  assert.ok(lines.some((l) => /秒后刷新再找/.test(l)));
});

test('publishVcItem: 有申请单号但列表里一直没有它时留空，不按同名商品去猜', async () => {
  const page = namedPage(APPLY_OK);
  installFakeChrome({ backend: page.backend, page: listPage({ records: [applyRecord('old-apply', 100448634314)] }) });
  const lines = [];
  const res = await publishVcItem(namedItem(), settings({ action: 'publish' }), (l) => lines.push(l), { imageMakers: makers, applyRetryMs: 1 });
  assert.equal(res.status, 'published');
  assert.deepEqual(res.skuIds, []);
  assert.ok(lines.some((l) => /申请单 new-apply 不在列表里/.test(l)), lines.join('\n'));
});

test('publishVcItem: 页面跳走、脚本没返回时，到落地页读回发布页存下的申请单号，再按它找 SKU', async () => {
  let fake;
  const landing = 'https://wares-jdm.jd.com/ware/wareList?businessModel=1&activeTab=ApplyWare';
  const page = namedPage(() => {
    for (const [id, tab] of fake.tabs) fake.tabs.set(id, { ...tab, url: landing });
    return {};
  });
  const records = [applyRecord('new-apply', 100448634999), applyRecord('old-apply', 100448634314)];
  fake = installFakeChrome({ backend: page.backend, page: listPage({ records, mark: { applyId: 'new-apply', serverTime: Date.now(), skuIds: [], text: '{"code":200}' } }) });
  const res = await publishVcItem(namedItem(), settings({ action: 'publish' }), () => {}, { imageMakers: makers, landTimeoutMs: 500, applyRetryMs: 1 });
  assert.equal(res.status, 'published', res.message);
  assert.equal(res.applyId, 'new-apply');
  assert.deepEqual(res.skuIds, ['100448634999']);
  assert.match(res.message, /申请单 new-apply/);
  const markCall = fake.calls.find((c) => c.name === 'readPublishMarkInPage');
  const runCall = page.calls.find((c) => c.method === 'runAction');
  assert.equal(markCall.args[0], runCall.args[1].nonce, '按这次发布的 nonce 读');
});

test('publishVcItem: 读不到列表组件数据时退回读文字，按服务器时间 15 秒内的同名商品对；上一次的同名商品不算', async () => {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const serverTime = Date.now();
  const page = namedPage({ ...APPLY_OK, serverTime });
  const texts = [`${SAME_NAME}\n商品编码: 100448634999\n提交: ${stamp(serverTime)}`, `${SAME_NAME}\n商品编码: 100448634314\n提交: ${stamp(serverTime - 75e3)}`];
  installFakeChrome({ backend: page.backend, page: listPage({ records: null, texts }) });
  const res = await publishVcItem(namedItem(), settings({ action: 'publish' }), () => {}, { imageMakers: makers, applyRetryMs: 1 });
  assert.deepEqual(res.skuIds, ['100448634999']);
});

test('方图上传期间主页面丢失：恢复表单并只提交一次', async () => {
  let first = true;
  const page = vcPage({
    vcPutImages: ([input]) => {
      if (first) {
        first = false;
        throw new Error('Frame with ID 0 was removed.');
      }
      return { ok: true, count: (input.images || input.names).length };
    },
    runAction: { ok: true, skuIds: ['100200300400'] },
  });
  installFakeChrome({ backend: page.backend });
  const result = await publishVcItem(vcItem(), settings({ action: 'submit_on' }), () => {}, { imageMakers: makers });
  assert.equal(result.status, 'published', result.message);
  assert.equal(page.methods().filter((m) => m === 'vcSetFields').length, 2);
  assert.equal(page.methods().filter((m) => m === 'runAction').length, 1);
});

test('上传时标签页消失：新开一页，第二次再中断时停止', async () => {
  const page = vcPage({
    vcPutImages: () => {
      fake.tabs.clear();
      throw new Error('Frame with ID 0 was removed.');
    },
  });
  const fake = installFakeChrome({ backend: page.backend });
  const res = await publishVcItem(vcItem(), settings({ action: 'submit_on' }), () => {}, { imageMakers: makers });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /提交前/);
  assert.equal(fake.ops().filter((op) => op === 'tabs.create').length, 2);
  assert.ok(!page.methods().includes('runAction'));
});

test('已点发布后丢失主页面且没有成功凭据：保留待核对状态且不重发', async () => {
  const page = vcPage({ runAction: () => { throw new Error('Frame with ID 0 was removed.'); } });
  installFakeChrome({ backend: page.backend });
  const result = await publishVcItem(vcItem(), settings({ action: 'submit_on' }), () => {}, { imageMakers: makers, landTimeoutMs: 0 });
  assert.equal(result.status, 'need_action');
  assert.equal(page.methods().filter((m) => m === 'runAction').length, 1);
});

test('业务繁忙失败表保留业务码和跟踪号', async () => {
  const page = vcPage({ runAction: { ok: false, messages: ['发布商品失败：业务繁忙'], saveResponses: [JSON.stringify({ code: 201, bCode: '10001', 'dsm-trace-id': 'example' })] } });
  installFakeChrome({ backend: page.backend });
  const res = await publishVcItem(vcItem(), settings({ action: 'submit_on' }), () => {}, { imageMakers: makers });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /业务繁忙.*code 201.*bCode 10001.*trace-id example/);
});
