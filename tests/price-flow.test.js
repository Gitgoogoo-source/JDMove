// 价格检查（采集窗口只读京东商品页显示的价格）的流程测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { checkPriceUrl } from '../src/lib/collector.js';

const ITEM_URL = 'https://item.jd.com/100001.html';
test('checkPriceUrl: 读出商品页显示的价格和标签', async () => {
  installFakeChrome({ page: () => ({ pageType: 'item', skuId: '100001', priceText: '60.5', label: '补贴价' }) });
  assert.deepEqual(await checkPriceUrl(ITEM_URL), { status: 'ok', price: 60.5, label: '补贴价' });
});

test('checkPriceUrl: 页面没有价格时报错（可能已下架），频控页要求暂停', async () => {
  installFakeChrome({ page: () => ({ pageType: 'item', priceText: '', label: '' }) });
  const none = await checkPriceUrl(ITEM_URL);
  assert.equal(none.status, 'error');
  assert.match(none.message, /没有显示价格/);

  installFakeChrome({ resolveUrl: () => 'https://safe.jd.com/verify', page: () => assert.fail('不应在验证页上执行脚本') });
  assert.equal((await checkPriceUrl(ITEM_URL)).status, 'throttle');
});
