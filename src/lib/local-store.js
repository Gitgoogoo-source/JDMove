// 把一个已采集的商品写到本地文件夹：<存储位置>/<品牌>/<SKU>/{主图,详情图,商品信息.*}
import { buildLocalPlan, pickBrandDir, safeName, IMAGE_DIRS } from '../shared/local-layout.js';
import { itemBrand } from '../shared/brand-folders.js';

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
 * @returns {Promise<{dir: string, saved: number, failed: string[]}>} dir 为相对存储位置的路径
 */
export async function saveItemToFolder(root, item, { fetchImpl = globalThis.fetch } = {}) {
  const plan = buildLocalPlan(item);
  const brandName = pickBrandDir(await subDirNames(root), plan.brand);
  const brandDir = await root.getDirectoryHandle(brandName, { create: true });
  const skuDir = await brandDir.getDirectoryHandle(plan.skuDir, { create: true });
  const result = await saveImages(skuDir, plan.images, fetchImpl);
  for (const f of plan.files) await writeFile(skuDir, f.name, new Blob([f.text], { type: 'text/plain;charset=utf-8' }));
  return { dir: `${brandName}/${plan.skuDir}`, ...result };
}

const isPlainName = (name) => Boolean(name) && !/[\\/]/.test(name) && !/^\.+$/.test(name);

async function isEmptyDir(dir) {
  for await (const _ of dir.entries()) return false;
  return true;
}

/** 商品的本地文件夹：优先用保存时记录的路径（只接受“品牌/SKU”这种两级、且末级就是该 SKU 的路径），否则按品牌推算 */
async function locateItemFolder(root, item) {
  const skuName = safeName(item.skuId);
  const [brand, sku, ...rest] = String(item.local?.dir ?? '').split('/');
  if (!rest.length && sku === skuName && isPlainName(brand)) return { brand, sku };
  if (!item.product) return null;
  return { brand: pickBrandDir(await subDirNames(root), itemBrand(item)), sku: skuName };
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
