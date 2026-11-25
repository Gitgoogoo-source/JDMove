import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/inject/backend-vc-images.js', import.meta.url), 'utf8');
const images = ['first.jpg', 'second.jpg', 'third.jpg'].map((name) => ({ name }));

function imageSpace({ multiple = true, autoOrder = (names) => names, missing = '' } = {}) {
  const captured = [{ name: missing, url: 'jfs/old.jpg', at: Date.now() }];
  const directory = { multiple: true };
  const input = { multiple };
  const cards = [];
  const selected = [];
  const changes = [];
  const previous = ['jfs/previous.jpg'];
  let current = previous;
  let confirmed = false;
  let opened = false;
  const dialog = { text: '图片空间' };
  const trigger = { scrollIntoView() {}, click: () => { opened = true; } };
  const cancel = { click: () => { opened = false; } };
  const confirm = { click() {
    confirmed = true;
    current = selected.map((name) => `jfs/${name}`);
    opened = false;
  } };

  const putFiles = (target, files) => {
    assert.equal(target, input);
    const names = Array.from(files, ({ name }) => name);
    changes.push(names);
    const successes = names.filter((name) => name !== missing);
    for (const name of successes.slice().reverse()) {
      captured.push({ name, url: `jfs/${name}`, at: Date.now() });
      const card = {
        classList: { contains: (key) => key === 'selected' && selected.includes(name) },
        querySelector: (key) => {
          if (key === '.image-name') return { text: name };
          if (key === '.select-sort') return { text: String(selected.indexOf(name) + 1) };
          return null;
        },
        click: () => queueMicrotask(() => {
          const index = selected.indexOf(name);
          if (index === -1) selected.push(name);
          else selected.splice(index, 1);
        }),
      };
      cards.push(card);
    }
    selected.push(...autoOrder(successes));
  };
  const backend = {
    __vc: true,
    getFApi: () => ({
      fields: () => ['imageList'],
      el: () => ({ $el: { querySelector: () => trigger } }),
      getValue: () => current,
      setValue: (_, value) => { current = value; },
    }),
    mediaUtil: { putFiles, b64ToFile: (img) => img, componentChain: () => ['upload-button'], installUploadCapture: () => captured },
    vcUtil: {},
    util: {
      sleep: async () => {},
      waitFor: async (fn) => { await Promise.resolve(); return fn() || null; },
      qsa: (key) => ({
        '.jd-overlay-dialog, .jd-dialog': opened ? [dialog] : [],
        'input[type=file]': [directory, input],
        'input[type=file]:not([webkitdirectory])': [input],
        '.dialog-card-item': cards,
        '.dialog-card-item.selected': cards.filter((card) => card.classList.contains('selected')),
      })[key] ?? [],
      visible: () => opened,
      textOf: (el) => el?.text ?? '',
      click: (el) => el.click(),
      buttonByText: (label) => label === '确定' ? confirm : cancel,
      messages: () => [],
    },
  };
  vm.runInNewContext(src, { window: { __JDMOVE__: { backend } } });
  return { changes, previous, confirmed: () => confirmed, value: () => current, fill: () => backend.vcPutImages({ field: 'imageList', images }) };
}

test('方图一次选择多张文件，自动勾选顺序与回填一致', async () => {
  const space = imageSpace();
  const result = await space.fill();
  assert.equal(result.ok, true);
  assert.deepEqual(space.changes, [images.map(({ name }) => name)]);
  assert.deepEqual(space.value(), images.map(({ name }) => `jfs/${name}`));
  assert.deepEqual(Array.from(result.urls), space.value());
});

test('京麦自动勾选顺序不同时，按原顺序勾选并保留首图', async () => {
  const space = imageSpace({ autoOrder: (names) => names.slice().reverse() });
  const result = await space.fill();
  assert.equal(result.ok, true);
  assert.equal(space.changes.length, 1);
  assert.deepEqual(space.value(), images.map(({ name }) => `jfs/${name}`));
});

test('批量上传少一张时取消回填，同名旧结果不算作本次上传', async () => {
  const space = imageSpace({ missing: images[1].name });
  const result = await space.fill();
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /second\.jpg/);
  assert.equal(space.confirmed(), false);
  assert.deepEqual(space.value(), space.previous);
});

test('旧的单选上传控件仍可逐张上传', async () => {
  const space = imageSpace({ multiple: false });
  const result = await space.fill();
  assert.equal(result.ok, true);
  assert.deepEqual(space.changes, images.map(({ name }) => [name]));
  assert.deepEqual(space.value(), images.map(({ name }) => `jfs/${name}`));
});
