import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseShopInput,
  buildShopSearchUrl,
  appIdFromLinks,
  parseTotalCount,
  pickShopInfo,
  buildFallbackSearchUrl,
  resolveNextUrl,
  SORT_FALLBACKS,
  SHOP_PAGE_SIZE,
} from '../src/shared/shop-url.js';

test('parseShopInput: 店铺搜索页链接解析出 appId / 分类 / 排序', () => {
  assert.deepEqual(parseShopInput('https://mall.jd.com/view_search-646206-0-99-1-24-1.html'), {
    kind: 'search',
    appId: '646206',
    categoryId: '0',
    orderBy: '99',
    direction: '1',
  });
});

test('parseShopInput: 支持二级域名、无协议、协议相对和带分类的分页链接', () => {
  const expected = { kind: 'search', appId: '646206', categoryId: '12933380', orderBy: '0', direction: '1' };
  assert.deepEqual(parseShopInput('//dovechocolate.jd.com/view_search-646206-12933380-0-1-24-3.html'), expected);
  assert.deepEqual(parseShopInput('  mall.jd.com/view_search-646206-12933380-0-1-24-3.html?x=1  '), expected);
});

test('parseShopInput: 店铺首页链接需要先打开首页找 appId', () => {
  assert.deepEqual(parseShopInput('https://mall.jd.com/index-1000078502.html?from=pc'), {
    kind: 'home',
    homeUrl: 'https://mall.jd.com/index-1000078502.html',
  });
  assert.deepEqual(parseShopInput('https://dovechocolate.jd.com/'), { kind: 'home', homeUrl: 'https://dovechocolate.jd.com/' });
});

test('parseShopInput: 移动端店铺链接转换为 PC 店铺首页', () => {
  const home = { kind: 'home', homeUrl: 'https://mall.jd.com/index-1000078502.html' };
  assert.deepEqual(parseShopInput('https://shop.m.jd.com/?shopId=1000078502'), home);
  assert.deepEqual(parseShopInput('https://shop.m.jd.com/shop/home?shopId=1000078502&venderId=1'), home);
});

test('parseShopInput: 店内搜索结果页（长格式）先打开页面读取店铺信息', () => {
  const home = { kind: 'home', homeUrl: 'https://mall.jd.com/view_search-630935-1000074722-1000074722-0-1-0-0-1-1-24.html' };
  assert.deepEqual(parseShopInput('https://mall.jd.com/view_search-630935-1000074722-1000074722-0-1-0-0-1-1-24.html?keyword=&isGlobalSearch=0'), home);
  assert.deepEqual(parseShopInput('//liangpinpuzizy.jd.com/view_search-630935-1000074722-1000074722-0-1-0-0-1-1-24.html'), home);
});

test('parseShopInput: 非店铺链接返回 null', () => {
  assert.equal(parseShopInput('https://item.jd.com/100035179134.html'), null);
  assert.equal(parseShopInput('https://www.jd.com/'), null);
  assert.equal(parseShopInput('https://search.jd.com/Search?keyword=德芙'), null);
  assert.equal(parseShopInput('https://evil.com/view_search-646206-0-99-1-24-1.html'), null);
  assert.equal(parseShopInput('https://jd.com.evil.com/index-1000078502.html'), null);
  assert.equal(parseShopInput('德芙巧克力'), null);
  assert.equal(parseShopInput(''), null);
  assert.equal(parseShopInput(undefined), null);
});

test('buildShopSearchUrl: URL 里每页条数固定写 24（京东服务端忽略更大的 pageSize）', () => {
  assert.equal(SHOP_PAGE_SIZE, 24);
  assert.equal(
    buildShopSearchUrl({ appId: '646206', categoryId: '0', orderBy: '99', direction: '1' }, 3),
    'https://mall.jd.com/view_search-646206-0-99-1-24-3.html',
  );
  assert.equal(buildShopSearchUrl({ appId: 646206 }, 1), 'https://mall.jd.com/view_search-646206-0-0-1-24-1.html');
});

test('buildShopSearchUrl: 参数非法时报错', () => {
  assert.throws(() => buildShopSearchUrl({ appId: 'abc' }, 1), /appId/);
  assert.throws(() => buildShopSearchUrl({ appId: '1', categoryId: '1/../x' }, 1), /分类/);
  assert.throws(() => buildShopSearchUrl({ appId: '1' }, 0), /页码/);
  assert.throws(() => buildShopSearchUrl({ appId: '1' }, 1.5), /页码/);
});

test('appIdFromLinks: 取首页链接中出现最多的 appId', () => {
  const links = [
    'https://mall.jd.com/view_search-646206-5634328-99-1-24-1.html',
    '//dovechocolate.jd.com/view_search-646206-12933380-99-1-24-1.html',
    'https://mall.jd.com/view_search-999-0-0-1-24-1.html',
    'https://item.jd.com/326467.html',
  ];
  assert.equal(appIdFromLinks(links), '646206');
  assert.equal(appIdFromLinks(['https://item.jd.com/1.html']), null);
  assert.equal(appIdFromLinks(undefined), null);
});

test('parseTotalCount: 解析不同模板的总数写法', () => {
  assert.equal(parseTotalCount(' 共117条记录 上一页 1 2 '), 117);
  assert.equal(parseTotalCount('共74件商品'), 74);
  assert.equal(parseTotalCount('共 12 个商品'), 12);
  assert.equal(parseTotalCount('共 0 条记录'), 0);
  assert.equal(parseTotalCount('上一页 下一页'), null);
  assert.equal(parseTotalCount(null), null);
});

test('pickShopInfo: appId 优先取页面隐藏字段，没有时再从链接里找', () => {
  const links = ['https://mall.jd.com/view_search-646206-0-99-1-24-1.html'];
  assert.deepEqual(pickShopInfo({ appId: '2202611', venderId: '1000396246', shopId: '1000396246', links }), {
    appId: '2202611',
    venderId: '1000396246',
    shopId: '1000396246',
  });
  assert.deepEqual(pickShopInfo({ appId: '', venderId: ' 1 ', shopId: 'x', links }), { appId: '646206', venderId: '1', shopId: null });
  assert.deepEqual(pickShopInfo(null), { appId: null, venderId: null, shopId: null });
});

test('buildFallbackSearchUrl: 关键词留空的店内搜索页', () => {
  assert.equal(
    buildFallbackSearchUrl({ appId: '630935', venderId: '1000074722', shopId: '1000074722' }),
    'https://mall.jd.com/view_search-630935-1000074722-1000074722-0-1-0-0-1-1-60.html?keyword=&isGlobalSearch=0',
  );
  assert.throws(() => buildFallbackSearchUrl({ appId: '630935', venderId: null, shopId: '1' }), /店铺信息/);
});

test('resolveNextUrl: “全部商品”页按本轮的排序参数重建地址（分页栏链接会丢掉排序参数）', () => {
  const params = { appId: '646206', categoryId: '0', orderBy: '99', direction: '1' };
  assert.equal(
    resolveNextUrl('//dovechocolate.jd.com/view_search-646206-0-0-1-24-2.html', params),
    'https://mall.jd.com/view_search-646206-0-99-1-24-2.html',
  );
});

test('resolveNextUrl: 其他格式（如店内搜索页）只把域名统一为 mall.jd.com', () => {
  const href = '//liangpinpuzizy.jd.com/view_search-494985-1000006804-1000006804-0-1-0-0-1-2-60.html?isGlobalSearch=0&other=';
  const expected = 'https://mall.jd.com/view_search-494985-1000006804-1000006804-0-1-0-0-1-2-60.html?isGlobalSearch=0&other=';
  assert.equal(resolveNextUrl(href, { appId: '494985', categoryId: '0', orderBy: '0', direction: '1' }), expected);
  assert.equal(resolveNextUrl(href, null), expected);
  // 其他店铺的“全部商品”页不按本店参数重建
  assert.equal(
    resolveNextUrl('https://mall.jd.com/view_search-1-0-0-1-24-2.html', { appId: '646206' }),
    'https://mall.jd.com/view_search-1-0-0-1-24-2.html',
  );
});

test('resolveNextUrl: 非京东店铺列表地址返回 null', () => {
  assert.equal(resolveNextUrl('javascript:;', null), null);
  assert.equal(resolveNextUrl('https://evil.com/view_search-1-0-0-1-24-2.html', null), null);
  assert.equal(resolveNextUrl('https://item.jd.com/1.html', null), null);
  assert.equal(resolveNextUrl('', null), null);
});

test('SORT_FALLBACKS: 补抓用的排序（上架时间、销量）', () => {
  assert.deepEqual(
    SORT_FALLBACKS.map((s) => [s.label, s.orderBy]),
    [
      ['上架时间', '1'],
      ['销量', '5'],
    ],
  );
});
