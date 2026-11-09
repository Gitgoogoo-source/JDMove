// 读取插件包里的 VC 上架模板（templates/vc/index.json + <三级类目ID>.json），读过的留在内存里
import { VC_TEMPLATE_DIR, findVcTemplateEntry, resolveVcTemplate } from '../shared/vc-templates.js';

const cache = new Map();

async function readJson(file) {
  if (cache.has(file)) return cache.get(file);
  const res = await fetch(chrome.runtime.getURL(`${VC_TEMPLATE_DIR}/${file}`));
  if (!res.ok) throw new Error(`读取上架模板 ${file} 失败（HTTP ${res.status}）`);
  const data = await res.json();
  cache.set(file, data);
  return data;
}

/**
 * 按类目ID（或类目ID路径）取上架模板；路径里有四级类目时取该四级类目的模板；没有录制过该类目时返回 null
 * @param {Array<string|number>|string|number} categoryIds
 * @returns {Promise<object|null>}
 */
export async function loadVcTemplate(categoryIds) {
  const entry = findVcTemplateEntry(await readJson('index.json'), categoryIds);
  return entry ? resolveVcTemplate(entry, await readJson(entry.file), categoryIds) : null;
}

/**
 * 全部上架模板（发布前检查弹窗里选模板用）；某份模板读不出来时跳过并写进 errors
 * @returns {Promise<{catalog: import('../shared/vc-templates.js').VcTemplateCatalog, errors: string[]}>}
 */
export async function loadVcCatalog() {
  const index = await readJson('index.json');
  const entries = index?.templates ?? [];
  const results = await Promise.allSettled(entries.map((e) => readJson(e.file)));
  const byId = new Map();
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) byId.set(entries[i].categoryId, r.value);
    else errors.push(`上架模板「${entries[i].categoryName}」读取失败：${r.reason?.message ?? '文件为空'}`);
  });
  return { catalog: { entries: entries.filter((e) => byId.has(e.categoryId)), byId }, errors };
}
