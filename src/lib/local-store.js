// 把一个已采集的商品写到本地文件夹：<存储位置>/<品牌>/<SKU>/{主图,详情图,商品信息.*}
import { buildLocalPlan, pickBrandDir, safeName, IMAGE_DIRS, IMAGE_EXTS, INFO_JSON } from '../shared/local-layout.js';
import { brandKey, itemBrand } from '../shared/brand-folders.js';
import { isTransparentPng } from './images.js';

const IMAGE_CONCURRENCY = 4;

async function subDirNames(dir) {
  const names = [];
  for await (const [name, handle] of dir.entries()) if (handle.kind === 'directory') names.push(name);
  return names;
}

async function writeFile(dir, name, data) {
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(data);
  } finally {
    await writable.close();
  }
}

/**
 * 把一个文件写到存储位置下的某个文件夹里（如 发布前检查/xxx.xlsx），文件夹没有时新建
 * @param {FileSystemDirectoryHandle} root
 * @param {string} dirName
 * @param {string} fileName
 * @param {Uint8Array|Blob} data
 * @returns {Promise<string>} 相对存储位置的路径
 */
export async function saveFileToFolder(root, dirName, fileName, data) {
  const dir = await root.getDirectoryHandle(safeName(dirName), { create: true });
  const name = safeName(fileName);
  await writeFile(dir, name, data);
  return `${dir.name}/${name}`;
}

async function removeIfExists(dir, name) {
  try {
    await dir.removeEntry(name, { recursive: true });
  } catch (e) {
    if (e?.name !== 'NotFoundError') throw e;
  }
}

async function downloadImage(url, fetchImpl) {
  const res = await fetchImpl(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/** 并发下载并写入图片；单张失败只记录，不影响其他图片 */
async function saveImages(skuDir, images, fetchImpl) {
  const dirs = {};
  for (const name of Object.values(IMAGE_DIRS)) {
    // 重新保存时先清掉旧图，避免图片数量变少后残留
    await removeIfExists(skuDir, name);
    if (images.some((img) => img.dir === name)) dirs[name] = await skuDir.getDirectoryHandle(name, { create: true });
  }
  const failed = [];
  let next = 0;
  const worker = async () => {
    while (next < images.length) {
      const img = images[next++];
      try {
        await writeFile(dirs[img.dir], img.name, await downloadImage(img.url, fetchImpl));
      } catch {
        failed.push(`${img.dir}/${img.name}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, images.length) }, worker));
  return { saved: images.length - failed.length, failed };
}

/**
 * @param {FileSystemDirectoryHandle} root 用户选择的存储位置
 * @param {object} item 已采集的任务条目
 * @param {{fetchImpl?: typeof fetch, raw?: object|null}} [opts] raw：刚采集时页面返回的原始数据（写进 原始数据.json）
 * @returns {Promise<{dir: string, saved: number, failed: string[]}>} dir 为相对存储位置的路径
 */
export async function saveItemToFolder(root, item, { fetchImpl = globalThis.fetch, raw = null } = {}) {
  const plan = buildLocalPlan(item, { raw });
  const brandName = pickBrandDir(await subDirNames(root), plan.brand);
  const brandDir = await root.getDirectoryHandle(brandName, { create: true });
  const skuDir = await brandDir.getDirectoryHandle(plan.skuDir, { create: true });
  const result = await saveImages(skuDir, plan.images, fetchImpl);
  for (const f of plan.files) await writeFile(skuDir, f.name, new Blob([f.text], { type: 'text/plain;charset=utf-8' }));
  return { dir: `${brandName}/${plan.skuDir}`, ...result };
}

/** 从存储位置的品牌/SKU/商品信息.json 中查找上架表需要的采集记录。 */
export async function findCollectedItems(root, skuIds) {
  const wanted = new Set(skuIds);
  const found = new Map();
  const unreadable = new Set();
  for await (const [brand, brandDir] of root.entries()) {
    if (brandDir.kind !== 'directory') continue;
    for await (const [skuId, skuDir] of brandDir.entries()) {
      if (skuDir.kind !== 'directory' || !wanted.has(skuId)) continue;
      try {
        const file = await (await skuDir.getFileHandle(INFO_JSON)).getFile();
        const data = JSON.parse(await file.text());
        const record = data?.app === 'jdmove' && Array.isArray(data.items)
          ? data.items.find((item) => String(item?.skuId) === skuId)
          : null;
        if (!record?.product || typeof record.product !== 'object' || Array.isArray(record.product) || !Object.keys(record.product).length) {
          unreadable.add(skuId);
          continue;
        }
        const savedAt = Date.parse(data.exportedAt) || 0;
        if (!found.has(skuId) || found.get(skuId).local.savedAt < savedAt) {
          found.set(skuId, { skuId, product: record.product, edits: record.edits, local: { dir: `${brand}/${skuId}`, savedAt } });
        }
      } catch (e) {
        if (e?.name !== 'NotFoundError') unreadable.add(skuId);
      }
    }
  }
  return { items: [...found.values()], unreadable: [...unreadable].filter((id) => !found.has(id)) };
}

const isPlainName = (name) => Boolean(name) && !/[\\/]/.test(name) && !/^\.+$/.test(name);

async function isEmptyDir(dir) {
  for await (const _ of dir.entries()) return false;
  return true;
}

/** 商品的本地文件夹：优先用保存时记录的路径（只接受“品牌/SKU”这种两级、且末级就是该 SKU 的路径），否则按品牌推算 */
async function locateItemFolder(root, item, brandNames) {
  const skuName = safeName(item.skuId);
  const [brand, sku, ...rest] = String(item.local?.dir ?? '').split('/');
  if (!rest.length && sku === skuName && isPlainName(brand)) return { brand, sku };
  if (!item.product) return null;
  return { brand: pickBrandDir(brandNames ?? await subDirNames(root), itemBrand(item)), sku: skuName };
}

/** 读取当前文件，发布与预览共用。返回 null 表示没有本地主图目录。 */
export async function readLocalPublishImages(root, item, { isTransparent = isTransparentPng } = {}) {
  const brandNames = await subDirNames(root);
  const target = await locateItemFolder(root, item, brandNames);
  if (!target) return null;
  const sourceBrand = itemBrand({ product: item.product });
  const knownBrands = [target.brand, itemBrand(item), sourceBrand].filter(Boolean);
  const folders = [...new Set([
    target.brand,
    ...knownBrands.map((name) => safeName(name)),
    ...brandNames.filter((name) => knownBrands.some((brand) => brandKey(brand) === brandKey(name))),
  ])];
  for (const brand of folders) {
    let dir;
    try {
      const brandDir = await root.getDirectoryHandle(brand);
      const skuDir = await brandDir.getDirectoryHandle(target.sku);
      dir = await skuDir.getDirectoryHandle(IMAGE_DIRS.main);
    } catch (e) {
      if (e?.name === 'NotFoundError' || e?.name === 'TypeMismatchError') continue;
      throw e;
    }

    const entries = [];
    for await (const [name, handle] of dir.entries()) {
      const ext = name.split('.').pop().toLowerCase();
      if (handle.kind === 'file' && !name.startsWith('.') && name.includes('.') && IMAGE_EXTS.has(ext)) {
        entries.push({ name, handle });
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    const main = [];
    let transparent = null;
    for (const { name, handle } of entries) {
      const file = await handle.getFile();
      if (!file.size) throw new Error(`主图文件为空：${name}`);
      const namedTransparent = /透图|透明|transparent/i.test(name);
      const numberedTransparent = /^0*6\.png$/i.test(name);
      if ((namedTransparent || numberedTransparent) && /\.png$/i.test(name) && await isTransparent(file)) {
        if (transparent) throw new Error('主图目录中有多张透图，请只保留一张');
        transparent = file;
      } else {
        if (namedTransparent) throw new Error(`透图需要透明底 PNG：${name}`);
        main.push(file);
      }
    }
    return { main, transparent, dir: `${brand}/${target.sku}/${IMAGE_DIRS.main}` };
  }
  return null;
}

/** 本地 URL 只在当前预览或发布期间有效。 */
export function localPublishImageUrls(files) {
  if (!files) return null;
  const mainImageUrls = files.main.map((file) => URL.createObjectURL(file));
  const transparentUrl = files.transparent ? URL.createObjectURL(files.transparent) : null;
  return {
    mainImageUrls,
    transparentUrl,
    dir: files.dir,
    release() {
      mainImageUrls.forEach((url) => URL.revokeObjectURL(url));
      if (transparentUrl) URL.revokeObjectURL(transparentUrl);
    },
  };
}

/**
 * 删除商品的本地文件夹（品牌/SKU，含图片和商品信息）；品牌文件夹删空后一并删除
 * @returns {Promise<{dir: string, removed: boolean}|null>} 无法确定位置时返回 null；removed=false 表示文件夹本来就不存在
 */
export async function removeItemFolder(root, item) {
  const target = await locateItemFolder(root, item);
  if (!target) return null;
  const dir = `${target.brand}/${target.sku}`;
  let brandDir;
  try {
    brandDir = await root.getDirectoryHandle(target.brand);
    await brandDir.removeEntry(target.sku, { recursive: true });
  } catch (e) {
    if (e?.name === 'NotFoundError' || e?.name === 'TypeMismatchError') return { dir, removed: false };
    throw e;
  }
  if (await isEmptyDir(brandDir)) await removeIfExists(root, target.brand);
  return { dir, removed: true };
}
