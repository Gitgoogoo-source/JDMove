// 上架表：从“参考链接”列读出要采集的商品；一个格子多个链接、同一链接多行、认得出的标准列一起导入
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractItemLinks } from '../src/shared/url-utils.js';
import { LISTING_HEADER_MISSING, listingEdit, parseListingBook } from '../src/shared/listing-sheet.js';

const jd = (id) => `https://item.jd.com/${id}.html`;
const sheet = (rows, name = '与京东对齐') => ({ name, rows });

test('extractItemLinks：只认链接（不认格子里的条形码等纯数字），按出现顺序去重；万商链接原样保留', () => {
  const text = `乐事薯片组合装104g*3罐  ${jd('3031035')}?spm=a\n条码 6924743915824 ${jd('3031035')}\n万商 https://b2b.jd.com/goods/goods-detail/100289450311?buId=1`;
  const links = extractItemLinks(text);
  assert.deepEqual(
    links.map((l) => [l.skuId, l.url]),
    [
      ['3031035', jd('3031035')],
      ['100289450311', 'https://b2b.jd.com/goods/goods-detail/100289450311?buId=1'],
    ],
  );
});

test('parseListingBook：表头“参考链接(多包/组合/新规格)”也认；一个格子多个链接各算一个商品，名称写进说明；同一链接多行只采一次', () => {
  const rows = [
    ['乐事 10 月上架'],
    ['品牌', '条形码', '京东链接', '参考链接(多包/组合/新规格)'],
    ['乐事', '6924743915824', jd('885163'), ''],
    ['乐事', '6924743915770', '', `乐事薯片组合装104g*3罐  ${jd('3031035')}\n乐事薯片休闲零食104g*3罐  ${jd('963181')}`],
    ['乐事', '6924743915763', '', `乐事Stax 混合装40g*6罐 ${jd('100124036683')}`],
    ['乐事', '6924743915764', '', `乐事Stax 混合装40g*6罐 ${jd('100124036683')}`],
    ['乐事', '', '', '找不到链接的说明'],
  ];
  const res = parseListingBook([sheet(rows), sheet([['说明']], '说明')]);
  assert.equal(res.error, undefined);
  assert.deepEqual(res.sheets, ['与京东对齐']);
  assert.deepEqual(
    res.links.map((l) => [l.skuId, l.label, l.refs.map((r) => r.row)]),
    [
      ['3031035', '乐事薯片组合装104g*3罐', [4]],
      ['963181', '乐事薯片休闲零食104g*3罐', [4]],
      ['100124036683', '乐事Stax 混合装40g*6罐', [5, 6]],
    ],
    '“京东链接”列不读',
  );
  assert.deepEqual(res.noLink.map((r) => r.row), [3]);
  assert.match(res.problems.find((p) => p.row === 7).text, /没有京东商品链接/);
  assert.equal(res.problems.find((p) => p.row === 7).sheet, '与京东对齐');
});

test('parseListingBook：没有“参考链接”列时报错；隐藏的工作表不读', () => {
  assert.equal(parseListingBook([sheet([['商品链接'], [jd('885163')]])]).error, LISTING_HEADER_MISSING);
  const hidden = { ...sheet([['参考链接'], [jd('885163')]], '旧表'), hidden: true };
  assert.equal(parseListingBook([hidden]).error, LISTING_HEADER_MISSING);
});

test('parseListingBook：标准列（价格/ERP/条形码/型号）只在一行一个链接、且链接只出现在这一行时导入；“京东价(到手价)”不读', () => {
  const rows = [
    ['参考链接', '市场价（元）', '京东价', '京东价(到手价)', '采购价', '采购员ERP', '销售员ERP', '条形码', '型号'],
    [jd('100000000001'), '¥39.90', '29.9', '7.9', '20', 'a.b', 'c_d', '6924743915824', 'X1'],
    [`${jd('100000000002')} ${jd('100000000003')}`, '39', '', '', '', '', '', '', ''],
    [jd('100000000004'), '39', '29.999', '', '', '张三', '', '123', ''],
    [jd('100000000005'), '39', '', '', '', '', '', '', ''],
    [jd('100000000005'), '49', '', '', '', '', '', '', ''],
    [jd('100000000006'), '', '', '', '', '', '', '', ''],
  ];
  const res = parseListingBook([sheet(rows)]);
  const byId = new Map(res.values.map((v) => [v.skuId, v.values]));
  assert.deepEqual(byId.get('100000000001'), { marketPrice: 39.9, jdPrice: 29.9, costPrice: 20, buyer: 'a.b', saler: 'c_d', upc: '6924743915824', model: 'X1' });
  assert.equal(byId.has('100000000002'), false);
  assert.deepEqual(byId.get('100000000004'), { marketPrice: 39 }, '不合规的值跳过，其余照导');
  assert.equal(byId.has('100000000005'), false, '同一链接两行填的不一样：都不导入');
  assert.equal(byId.has('100000000006'), false);
  const texts = res.problems.map((p) => `${p.row}:${p.text}`);
  assert.ok(texts.some((t) => t.startsWith('3:') && /2 个参考链接/.test(t)), texts.join('\n'));
  assert.ok(texts.some((t) => t.startsWith('4:') && /最多 2 位小数/.test(t)));
  assert.ok(texts.some((t) => t.startsWith('4:') && /采购员ERP/.test(t)));
  assert.ok(texts.some((t) => t.startsWith('4:') && /条形码/.test(t)));
  assert.ok(texts.some((t) => /第 5、6 行/.test(t)));
});

test('listingEdit：值写进编辑内容（价格/协议价/ERP/型号 → VC 自营，条形码 → UPC）', () => {
  const edit = listingEdit({ marketPrice: 39.9, jdPrice: 29.9, agreementPrice: 18.5, buyer: 'a.b', saler: 'a.b', upc: '6924743915824', model: 'X1' });
  const next = edit({ title: 'T', vc: { costPrice: 20 } });
  assert.deepEqual(next, { title: 'T', vc: { costPrice: 20, marketPrice: 39.9, jdPrice: 29.9, agreementPrice: 18.5, erpCode: 'a.b', model: 'X1' }, upc: '6924743915824' });
});
