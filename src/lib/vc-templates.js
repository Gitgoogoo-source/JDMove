// 读取插件包里的 VC 上架模板（templates/vc/index.json + <三级类目ID>.json），读过的留在内存里
import { VC_TEMPLATE_DIR, findVcTemplateEntry } from '../shared/vc-templates.js';

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
 * 按类目ID（或类目ID路径）取上架模板；没有录制过该类目时返回 null
 * @param {Array<string|number>|string|number} categoryIds
 * @returns {Promise<object|null>}
 */
export async function loadVcTemplate(categoryIds) {
  const entry = findVcTemplateEntry(await readJson('index.json'), categoryIds);
  return entry ? readJson(entry.file) : null;
}
