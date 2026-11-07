// 商品页主数据（wareInfoReadMap）里 VC 发布要用的字段
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vcSourceInfo } from '../src/shared/vc-source.js';
import { normalizeProduct } from '../src/shared/product-normalize.js';

// 2026-11 维达抽纸 100114866451 商品页的 wareInfoReadMap（节选）
const VINDA = {
  category_id1: '15901',
  category_id2: '15902',
  category_id: '15908',
  category_id4: '31403',
  brand_id: '17519',
  model: 'V2833-D',
  weight: '4.330',
  length: '408',
  width: '310',
  height: '280',
  warranty: '无质保',
  upc_code: '6901236326411',
  shelf_life: '0',
  realSpuId: '100014512908',
  main_sku_id: '100014512908',
  isdangergoods: '0',
  seriesId: '801106',
  features2:
    'bjxp:0;cxgm:1;shortTitle:维达 棉韧抽纸3层100抽36包;skuNameWithoutBrand:抽纸【孙颖莎推荐】棉韧3层100抽*36包S码 亲肤无刺激纸巾 AB混发;xxhf:1',
  sale_attributes: '[{"dim":1,"saleName":"规格","saleValue":"【王牌囤货装】 3层 100抽*36包","sequenceNo":4}]',
};

const EMPTY_EXTRA = { spuId: '', seriesId: '', dangerGoods: null, shortTitle: '', titleNoBrand: '', saleAttrs: [] };

test('vcSourceInfo: 取出四级类目、品牌、型号、长宽高、毛重、质保', () => {
  assert.deepEqual(vcSourceInfo(VINDA), {
    cateIds: ['15901', '15902', '15908', '31403'],
    brandId: 17519,
    model: 'V2833-D',
    weightKg: 4.33,
    lengthMm: 408,
    widthMm: 310,
    heightMm: 280,
    warranty: '无质保',
    spuId: '100014512908',
    seriesId: '801106',
    dangerGoods: false,
    shortTitle: '维达 棉韧抽纸3层100抽36包',
    titleNoBrand: '抽纸【孙颖莎推荐】棉韧3层100抽*36包S码 亲肤无刺激纸巾 AB混发',
    saleAttrs: [{ name: '规格', value: '【王牌囤货装】 3层 100抽*36包' }],
  });
});

test('vcSourceInfo: SPU 优先 realSpuId，没有时用 main_sku_id；危险品 1 为 true', () => {
  assert.equal(vcSourceInfo({ main_sku_id: '100014512908' }).spuId, '100014512908');
  assert.equal(vcSourceInfo({ realSpuId: '0', main_sku_id: 'x' }).spuId, '');
  assert.equal(vcSourceInfo({ isdangergoods: '1' }).dangerGoods, true);
  assert.equal(vcSourceInfo({ isdangergoods: '' }).dangerGoods, null);
});

test('vcSourceInfo: features2 / sale_attributes 格式不对时忽略，不报错', () => {
  const info = vcSourceInfo({ features2: 'abc;;shortTitle:;x', sale_attributes: '{not json' });
  assert.equal(info.shortTitle, '');
  assert.equal(info.titleNoBrand, '');
  assert.deepEqual(info.saleAttrs, []);
  assert.deepEqual(vcSourceInfo({ sale_attributes: '[{"saleName":"","saleValue":"x"},null,{"saleName":"颜色","saleValue":" 红 "}]' }).saleAttrs, [
    { name: '颜色', value: '红' },
  ]);
});

test('vcSourceInfo: 三级类目的商品没有 category_id4（空串、0 或与三级相同都忽略）', () => {
  for (const id4 of ['', '0', '15908', undefined]) {
    assert.deepEqual(vcSourceInfo({ ...VINDA, category_id4: id4 }).cateIds, ['15901', '15902', '15908'], String(id4));
  }
});

test('vcSourceInfo: 缺字段或不是正数时为 null / 空串，不编造', () => {
  assert.deepEqual(vcSourceInfo({ weight: '0', length: 'abc', width: '', height: '-1', brand_id: '0', model: '  ' }), {
    cateIds: [],
    brandId: null,
    model: '',
    weightKg: null,
    lengthMm: null,
    widthMm: null,
    heightMm: null,
    warranty: '',
    ...EMPTY_EXTRA,
  });
  assert.equal(vcSourceInfo(undefined).brandId, null);
  assert.deepEqual(vcSourceInfo(null).cateIds, []);
});

test('normalizeProduct: 商品带上 vc 字段；旧数据没有 wareInfo 时 vc 为空值', () => {
  const raw = { url: 'https://item.jd.com/100114866451.html', skuId: '100114866451', domTitle: 't', params: [], wareInfo: VINDA };
  const p = normalizeProduct(raw);
  assert.deepEqual(p.vc.cateIds, ['15901', '15902', '15908', '31403']);
  assert.equal(p.vc.brandId, 17519);
  assert.equal(p.vc.model, 'V2833-D');
  assert.equal(normalizeProduct({ ...raw, wareInfo: undefined }).vc.brandId, null);
});
