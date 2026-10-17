import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShopInput, buildShopSearchUrl, appIdFromLinks, parseTotalCount, SHOP_PAGE_SIZE } from '../src/shared/shop-url.js';

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

test('buildShopSearchUrl: 每页固定 24 条（京东服务端忽略更大的 pageSize）', () => {
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

test('parseTotalCount: 解析“共117条记录”', () => {
  assert.equal(parseTotalCount(' 共117条记录 上一页 1 2 '), 117);
  assert.equal(parseTotalCount('共 0 条记录'), 0);
  assert.equal(parseTotalCount('上一页 下一页'), null);
  assert.equal(parseTotalCount(null), null);
});
