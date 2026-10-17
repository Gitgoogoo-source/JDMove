import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSkuIds,
  buildItemUrl,
  toOriginalImageUrl,
  jfsPathOf,
  classifyPageUrl,
  buildPublishUrl,
  imgzoneUrl,
} from '../src/shared/url-utils.js';

test('extractSkuIds finds ids in mixed text and dedupes in order', () => {
  const text = `
    https://item.jd.com/100012043978.html?spm=1
    item.m.jd.com/product/100009077475.html
    https://item.jd.com/100012043978.html
    100019867468
    abc 12345
  `;
  assert.deepEqual(extractSkuIds(text), ['100012043978', '100009077475', '100019867468']);
});

test('extractSkuIds ignores short numbers', () => {
  assert.deepEqual(extractSkuIds('price 39900 order 12'), []);
});

test('buildItemUrl builds canonical PC url', () => {
  assert.equal(buildItemUrl('123456789'), 'https://item.jd.com/123456789.html');
});

test('toOriginalImageUrl upgrades thumbnails to n0 originals', () => {
  assert.equal(
    toOriginalImageUrl('//img14.360buyimg.com/n5/s54x54_jfs/t1/123/4/5/abc.jpg.avif'),
    'https://img14.360buyimg.com/n0/jfs/t1/123/4/5/abc.jpg',
  );
  assert.equal(
    toOriginalImageUrl('https://img30.360buyimg.com/sku/jfs/t1/9/8/7/x.png!q70.dpg.webp'),
    'https://img30.360buyimg.com/sku/jfs/t1/9/8/7/x.png',
  );
  assert.equal(toOriginalImageUrl('jfs/t1/1/2/3/y.jpg'), 'https://img14.360buyimg.com/n0/jfs/t1/1/2/3/y.jpg');
  // 新版商品页：pcpubliccms 缩略图
  assert.equal(
    toOriginalImageUrl('https://img10.360buyimg.com/pcpubliccms/s228x228_jfs/t1/488474/9/1/2/00833e.jpg.avif'),
    'https://img14.360buyimg.com/n0/jfs/t1/488474/9/1/2/00833e.jpg',
  );
  assert.equal(
    toOriginalImageUrl('//img30.360buyimg.com/sku/jfs/t1/485491/10/1/2/00d63e.png.avif'),
    'https://img30.360buyimg.com/sku/jfs/t1/485491/10/1/2/00d63e.png',
  );
  assert.equal(toOriginalImageUrl(''), '');
});

test('toOriginalImageUrl keeps non-jd urls but fixes protocol', () => {
  assert.equal(toOriginalImageUrl('//example.com/a.jpg'), 'https://example.com/a.jpg');
});

test('jfsPathOf extracts jfs path', () => {
  assert.equal(jfsPathOf('https://img10.360buyimg.com/imgzone/jfs/t1/1/2/3/z.jpg'), 'jfs/t1/1/2/3/z.jpg');
  assert.equal(jfsPathOf('https://a.com/b.jpg'), null);
});

test('classifyPageUrl detects throttle, login and item pages', () => {
  assert.equal(classifyPageUrl('https://pc-frequent-pro.pf.jd.com/?from=pc_item&reason=403'), 'throttle');
  assert.equal(classifyPageUrl('https://passport.jd.com/new/login.aspx?ReturnUrl=x'), 'login');
  assert.equal(classifyPageUrl('https://cfe.m.jd.com/privatedomain/risk_handler/03101900/'), 'throttle');
  assert.equal(
    classifyPageUrl('https://bizsafe-intercept.jd.com/?block_prompt=1&returnurl=https%3A%2F%2Fitem.jd.com%2F1.html'),
    'merchant_block',
  );
  assert.equal(classifyPageUrl('https://item.jd.com/100.html'), 'item');
  assert.equal(classifyPageUrl('https://wares-jdm.jd.com/popPublish/?categoryId=1'), 'publish');
  assert.equal(classifyPageUrl('https://wares-jdm.jd.com/ware/categorySelectNew?source=1'), 'category');
  assert.equal(classifyPageUrl('https://www.baidu.com/'), 'other');
  assert.equal(classifyPageUrl('not a url'), 'other');
});

test('buildPublishUrl encodes category path', () => {
  const url = buildPublishUrl({ cateList: [17991, 17994, 18132] });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://wares-jdm.jd.com/popPublish/');
  assert.equal(u.searchParams.get('categoryId'), '18132');
  assert.equal(u.searchParams.get('cateList'), '17991,17994,18132');
  assert.equal(u.searchParams.get('newFlow'), '1');
});

test('buildPublishUrl rejects empty category path', () => {
  assert.throws(() => buildPublishUrl({ cateList: [] }), /类目/);
});

test('imgzoneUrl prefixes jfs path', () => {
  assert.equal(imgzoneUrl('jfs/t1/a.jpg'), 'https://img10.360buyimg.com/imgzone/jfs/t1/a.jpg');
});
