import test from 'node:test';
import assert from 'node:assert/strict';
import { collectedProductsSheet } from '../src/shared/collected-products-sheet.js';
import { buildXlsx } from '../src/shared/xlsx-write.js';
import { readXlsxSheets } from '../src/shared/xlsx-read.js';
import { readZipEntries } from '../src/shared/zip.js';

test('采集数据表保留源价格、三级类目、SKU 和对应的京东商品链接，缺失字段留空', async () => {
  const bytes = buildXlsx([collectedProductsSheet([
    {
      skuId: '00012345678901234567',
      product: { title: '采集标题', price: 149.9, crumbs: ['粮油调味', '食用油', '花生油', '品牌'] },
      edits: { title: '胡姬花花生油', vc: { jdPrice: 168 }, cateName: '目标类目' },
    },
    {
      skuId: '1234567',
      url: 'https://b2b.jd.com/goods/goods-detail/1234567',
      product: { title: '暂无报价的商品' },
      edits: { vc: { jdPrice: 39 } },
    },
  ])]);
  const [sheet] = await readXlsxSheets(bytes);
  assert.equal(sheet.name, '采集数据');
  assert.deepEqual(sheet.rows, [
    ['商品名称', '京东自营价格', '一二三级类目', 'sku编码', '京东自营链接'],
    ['胡姬花花生油', '149.9', '粮油调味 > 食用油 > 花生油', '00012345678901234567', 'https://item.jd.com/00012345678901234567.html'],
    ['暂无报价的商品', '', '', '1234567', 'https://item.jd.com/1234567.html'],
  ]);
  const xml = new TextDecoder().decode(readZipEntries(bytes).get('xl/worksheets/sheet1.xml').data);
  assert.match(xml, /<c r="B2"><v>149\.9<\/v><\/c>/);
  assert.match(xml, /<c r="D2" s="2" t="inlineStr">/);
});
