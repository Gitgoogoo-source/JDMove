import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, similarity, splitValues, toHalfWidth } from '../src/shared/text.js';

test('toHalfWidth converts full-width ASCII and spaces', () => {
  assert.equal(toHalfWidth('ＡＢＣ１２３　（）'), 'ABC123 ()');
});

test('normalizeName strips spaces, punctuation and case', () => {
  assert.equal(normalizeName(' 德芙（Dove） '), '德芙dove');
  assert.equal(normalizeName('国产/进口'), '国产进口');
  assert.equal(normalizeName('【包装】形式：'), '包装形式');
  assert.equal(normalizeName(null), '');
});

test('similarity is 1 for equal names and 0 for disjoint', () => {
  assert.equal(similarity('产地', '产地'), 1);
  assert.equal(similarity('产地', '颜色'), 0);
  assert.equal(similarity('', '颜色'), 0);
});

test('similarity is partial for overlapping names', () => {
  const s = similarity('包装形式', '包装');
  assert.ok(s > 0.3 && s < 1, `got ${s}`);
});

test('similarity handles single characters', () => {
  assert.equal(similarity('红', '红'), 1);
  assert.equal(similarity('红', '蓝'), 0);
});

test('splitValues splits on common separators and trims', () => {
  assert.deepEqual(splitValues('牛奶味， 抹茶味、黑巧/榛子;'), ['牛奶味', '抹茶味', '黑巧', '榛子']);
  assert.deepEqual(splitValues(''), []);
});
