// 固定的上架表模板：表头和读取规则一一对应，协议价能读出来、写进编辑；填写说明表不会被当成上架表
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LISTING_TEMPLATE_COLUMNS, listingTemplateSheets, listingTemplateXlsx } from '../src/shared/listing-template.js';
import { listingEdit, parseListingBook } from '../src/shared/listing-sheet.js';
import { readXlsxSheets } from '../src/shared/xlsx-read.js';
import { applyReviewValue, buildReview, REVIEW_FIELDS, reviewOwnValue } from '../src/shared/vc-review.js';
import { mergeSettings } from '../src/shared/settings.js';
import { parsePrice } from '../src/shared/vc-import.js';
import { parseApplyRows, pickPublishedSku } from '../src/shared/apply-list.js';

const HEADER = LISTING_TEMPLATE_COLUMNS.map((c) => c.header);
const row = (values) => HEADER.map((h) => values[h] ?? '');

test('上架表模板：两张表（上架表、填写说明），上架表只有表头；参考链接、条形码、ERP 是文本格式', async () => {
  const sheets = await readXlsxSheets(listingTemplateXlsx());
  assert.deepEqual(sheets.map((s) => s.name), ['上架表', '填写说明']);
  assert.deepEqual(sheets[0].rows, [HEADER]);
  assert.ok(HEADER.includes('协议价(元)') && HEADER.includes('参考链接') && HEADER.includes('条形码(69码)'));
  const spec = listingTemplateSheets()[0];
  assert.deepEqual(spec.textColumns.map((i) => HEADER[i]), ['参考链接', '条形码(69码)', '型号', '采购员ERP', '销售员ERP']);
});

test('上架表模板：照着填的每一列都读得到（含协议价），商品名称当说明；填写说明表不算上架表', () => {
  const sheets = listingTemplateSheets().map((s, i) =>
    i === 0
      ? {
          ...s,
          rows: [
            ...s.rows,
            row({ 品牌: '维达', 商品名称: '维达抽纸 36包', 参考链接: 'https://item.jd.com/100114866451.html', '市场价(元)': '89.9', '京东价(元)': '69.9', '采购价(元)': '50', '协议价(元)': '55.5', '条形码(69码)': '6901236326411', 型号: 'V2833', 采购员ERP: 'xudezhi.6', 销售员ERP: 'xudezhi.6' }),
          ],
        }
      : s,
  );
  const parsed = parseListingBook(sheets);
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.sheets, ['上架表']);
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.links[0].label, '维达抽纸 36包');
  assert.deepEqual(parsed.values[0].values, { marketPrice: 89.9, jdPrice: 69.9, costPrice: 50, agreementPrice: 55.5, upc: '6901236326411', model: 'V2833', buyer: 'xudezhi.6', saler: 'xudezhi.6' });
  const edits = listingEdit(parsed.values[0].values)({});
  assert.equal(edits.vc.agreementPrice, 55.5);
});

test('上架表：协议价格式不对时提醒、不导入，其余照导', () => {
  const parsed = parseListingBook([{ name: 'S', rows: [['参考链接', '协议价', '京东价'], ['https://item.jd.com/100114866451.html', '五十', '69.9']] }]);
  assert.deepEqual(parsed.values[0].values, { jdPrice: 69.9 });
  assert.match(parsed.problems[0].text, /协议价“五十”不是数字/);
  assert.match(parsePrice('agreementPrice', '1.12345').error, /最多 4 位小数/);
});

test('发布前检查：协议价是“价格与采销”里的选填项，不填不算缺，填的存进 edits.vc.agreementPrice', () => {
  const def = REVIEW_FIELDS.find((f) => f.key === 'agreementPrice');
  assert.equal(def.group, 'price');
  assert.ok(!def.required);
  const edits = applyReviewValue({ vc: { jdPrice: 9 } }, 'agreementPrice', '7.25');
  assert.deepEqual(edits, { vc: { jdPrice: 9, agreementPrice: 7.25 } });
  assert.equal(reviewOwnValue(edits, 'agreementPrice'), '7.25');
  const product = { title: 'x', brand: { id: 1, name: 'b' }, mainImages: [], detailImages: [], params: [] };
  const review = buildReview({ product, edits: {}, settings: mergeSettings({}) });
  const field = review.fields.find((f) => f.key === 'agreementPrice');
  assert.equal(field.state, 'ok');
  assert.ok(!review.problems.includes('协议价(元)'));
});

test('商品审核列表：读出名称、商品编码、提交时间；按名称和点发布之后的提交时间挑出 SKU', () => {
  const rows = parseApplyRows([
    '维达超韧抽纸3层150抽M码 3层150抽*24包\n商品编码: 100448634314\n提交: 2026-11-09 17:21:58\n审核通过',
    '没有编码的行',
    '维达超韧抽纸3层150抽M码 3层150抽*24包\n商品编码：100448634999\n提交：2026-11-20 14:05:10',
  ]);
  assert.deepEqual(rows.map((r) => r.sku), ['100448634314', '100448634999']);
  assert.equal(rows[0].name, '维达超韧抽纸3层150抽M码 3层150抽*24包');
  assert.equal(rows[0].submittedAt, new Date(2026, 10, 9, 17, 21, 58).getTime());
  const since = new Date(2026, 10, 20, 14, 5, 0).getTime();
  assert.equal(pickPublishedSku(rows, { name: '维达超韧抽纸3层150抽M码  3层150抽*24包', since }), '100448634999');
  assert.equal(pickPublishedSku(rows, { name: '别的', since }), '');
  assert.equal(pickPublishedSku(rows, { name: '', since }), '');
});
