// VC 类目选择页的子类目读取（inject/backend-vc-category.js）：按类目ID路径逐级点开，读 categoryColumn 组件的 props.list。
// 假页面：点第 d 列的类目后，第 d 列 defaultValue 变成它，后面的列换成它的子类目（和 2026-11-08 实测的页面一致）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CHOUZHI_CHILDREN } from './fixtures/vc-categories.js';

const SRC = readFileSync(new URL('../src/inject/backend-vc-category.js', import.meta.url), 'utf8');

// 页面上的数据：id 是数字，非末级类目的 publishEnable 是 false
const raw = (list) => list.map((c) => ({ ...c, id: Number(c.id), level: 4, child: null }));
const TREE = {
  root: [
    { id: 36720, name: '水饮冲调', isLeaf: false, publishEnable: false },
    { id: 15901, name: '家庭清洁/纸品', isLeaf: false, publishEnable: false },
  ],
  15901: [{ id: 15902, name: '清洁纸品', isLeaf: false, publishEnable: false }],
  15902: [
    { id: 15908, name: '抽纸', isLeaf: false, publishEnable: false, interpretation: null },
    { id: 15910, name: '手帕纸', isLeaf: true, publishEnable: true, interpretation: '该类目经营便携式纸巾品类商品' },
  ],
  15908: raw(CHOUZHI_CHILDREN),
};

/** vm 里创建的对象原型不同，深比较前转成普通对象 */
const plain = (v) => JSON.parse(JSON.stringify(v));

function fakePage() {
  let cols = [{ colIndex: 0, defaultValue: 0, list: TREE.root }];
  const clicks = [];
  const select = (depth, id) => {
    clicks.push(id);
    const head = cols.slice(0, depth).concat({ ...cols[depth], defaultValue: id });
    cols = TREE[id] ? [...head, { colIndex: depth + 1, defaultValue: 0, list: [...TREE[id]] }] : head;
  };
  const elements = () =>
    cols.flatMap((col, depth) => col.list.map((x) => ({ id: String(x.id), click: () => select(depth, x.id) })));
  const util = {
    qsa: (sel) => (sel === '.vc-category-column__name' ? elements() : []),
    visible: () => true,
    waitFor: async (fn) => {
      for (let i = 0; i < 10; i += 1) {
        const v = fn();
        if (v) return v;
        await Promise.resolve();
      }
      return fn() || null;
    },
    walkComponents: (visit) => {
      visit({ type: { name: 'JdTooltip' }, props: {} });
      for (const props of cols) if (visit({ type: { name: 'categoryColumn' }, props }) === true) return;
    },
  };
  const backend = { __core: true, util };
  vm.runInNewContext(SRC, { window: { __JDMOVE__: { backend } } });
  return { backend, clicks };
}

test('vcChildCategories: 逐级点开 15901 > 15902 > 15908，返回抽纸的 5 个子类目（ID 转成字符串）', async () => {
  const { backend, clicks } = fakePage();
  const res = await backend.vcChildCategories({ path: ['15901', '15902', '15908'] });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.leaf, false);
  assert.deepEqual(clicks, [15901, 15902, 15908]);
  assert.deepEqual(plain(res.children.map((c) => c.id)), ['44478', '44479', '31403', '31402', '31404']);
  assert.deepEqual(plain(res.children[2]), CHOUZHI_CHILDREN[2]);
});

test('vcChildCategories: 再读一次已经选中的路径时不重复点击也能拿到子类目', async () => {
  const { backend, clicks } = fakePage();
  await backend.vcChildCategories({ path: [15901, 15902, 15908] });
  const again = await backend.vcChildCategories({ path: [15901, 15902, 15908] });
  assert.equal(again.ok, true, again.error);
  assert.equal(again.children.length, 5);
  assert.deepEqual(clicks, [15901, 15902, 15908]);
});

test('vcChildCategories: 路径最后一级本身是末级类目时 leaf 为 true', async () => {
  const { backend } = fakePage();
  const res = await backend.vcChildCategories({ path: ['15901', '15902', '15910'] });
  assert.deepEqual(plain(res), { ok: true, leaf: true, children: [] });
});

test('vcChildCategories: 路径里的类目不在这一列（不在产品线或没从一级写起）时说明是第几级', async () => {
  const { backend } = fakePage();
  const res = await backend.vcChildCategories({ path: ['15902', '15908'] });
  assert.equal(res.ok, false);
  assert.match(res.error, /第 1 级里没有类目 15902/);
  const empty = await backend.vcChildCategories({ path: [] });
  assert.equal(empty.ok, false);
});

test('vcChildCategories: 中间某级已经是末级类目时报错', async () => {
  const { backend } = fakePage();
  const res = await backend.vcChildCategories({ path: ['15901', '15902', '15910', '1'] });
  assert.equal(res.ok, false);
  assert.match(res.error, /手帕纸\[15910\] 已经是末级类目/);
});
