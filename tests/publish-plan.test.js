// 发布用的图片计划与商品详情 HTML
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descriptionHtml, publishImagePlan } from '../src/shared/publish-plan.js';
import { mergeSettings } from '../src/shared/settings.js';

const product = {
  skuId: '100001',
  title: '德芙 丝滑牛奶巧克力 252g',
  mainImages: Array.from({ length: 12 }, (_, i) => `https://img/${i}.jpg`),
  detailImages: ['https://d/1.jpg', 'https://d/2.jpg'],
};

test('publishImagePlan: 不需要表单结构就能算出主图/详情图地址（用于提前处理图片）', () => {
  const settings = mergeSettings({ publish: { maxMainImages: 3, maxDetailImages: 1 } });
  const legacy = { ...product, mainImages: ['https://img14.360buyimg.com/n0/jfs/t1/1/2/3/a.jpg', 'https://img/1.jpg', 'https://img/2.jpg', 'https://img/3.jpg'] };
  assert.deepEqual(publishImagePlan({ product: legacy, settings }), {
    mainImageUrls: ['https://img14.360buyimg.com/sku/jfs/t1/1/2/3/a.jpg', 'https://img/1.jpg', 'https://img/2.jpg'],
    detailImageUrls: ['https://d/1.jpg'],
  });
});

test('publishImagePlan: 编辑里指定的主图优先；没有图片时返回空列表', () => {
  const settings = mergeSettings({});
  assert.deepEqual(publishImagePlan({ product, edits: { mainImages: ['https://img/x.jpg'] }, settings }).mainImageUrls, ['https://img/x.jpg']);
  assert.deepEqual(publishImagePlan({ product: { title: 't' }, settings }), { mainImageUrls: [], detailImageUrls: [] });
});

test('descriptionHtml wraps images in order and escapes urls', () => {
  const html = descriptionHtml(['https://a/1.jpg', 'https://a/2.jpg?x="y"']);
  assert.ok(html.indexOf('1.jpg') < html.indexOf('2.jpg'));
  assert.ok(!html.includes('"y"'));
  assert.equal(descriptionHtml([]), '');
});
