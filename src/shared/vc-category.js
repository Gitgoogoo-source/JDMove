// 源类目在 VC 后台不是末级类目时，自动选子类目（纯函数）。
// 京东把一些三级类目细分成了四级（2026-11 实测：抽纸[15908] → 常规抽纸/悬挂式抽纸/擦手纸/本色抽纸/乳霜纸，
// 卷纸[15909] → 大盘纸/有芯卷纸/无芯卷纸），老商品的主数据还挂在三级类目上，VC 发布页只认末级类目
// （打开后显示“您选择的类目不是末级类目”）。子类目来自 VC 类目选择页，每个都带一句说明：“…包含A、B、C商品…”
import { normalizeName } from './text.js';
import { titleWithoutBrand } from './vc-plan.js';

const INCLUDES_RE = /包含[：:]?(.+?)商品/;
const LIST_SEP_RE = /[、，,]/;
const MIN_KEYWORD_LEN = 2;
// 常规类目：商品信息里没有更具体的特征时选它
const GENERAL_RE = /^(常规|普通|通用|标准)/;
// 标题开头这么多字（去掉品牌、空格和标点后）算“商品是什么”，后面多是堆砌的搜索词（如抽纸标题末尾的“擦手纸”）
const LEAD_CHARS = 15;
// 属性里出现、标题开头出现算明确依据；只在标题后半段出现算弱依据
const STRONG = 3;
const WEAK = 1;

/** 子类目的关键词：类目名 + 说明里“包含…商品”列出的词 */
export function childKeywords(child) {
  const listed = (String(child?.interpretation ?? '').match(INCLUDES_RE)?.[1] ?? '').split(LIST_SEP_RE);
  const words = [child?.name, ...listed].map(normalizeName).filter((w) => w.length >= MIN_KEYWORD_LEN);
  return [...new Set(words)];
}

/**
 * 判断子类目用的商品信息（都已归一化）：标题去掉品牌；texts 是属性值（属性覆盖在前）。
 * 不用面包屑：里面只有上级类目名（如“抽纸”），会让说明里列了上级名的子类目白白得分
 * @param {{title?: string, brand?: {name?: string}, params?: {name: string, value: string}[], crumbs?: string[]}} product
 * @param {{attrOverrides?: Record<string, string>}} [edits]
 * @returns {{title: string, texts: string[]}}
 */
export function leafHints(product, edits = {}) {
  const overrides = Object.values(edits?.attrOverrides ?? {});
  const params = (product?.params ?? []).map((p) => p?.value);
  const texts = [...overrides, ...params].map(normalizeName).filter(Boolean);
  return { title: normalizeName(titleWithoutBrand(product?.title, product?.brand?.name)), texts };
}

/** 一个关键词的依据强度：属性或标题开头里有 → STRONG；只在标题后面有 → WEAK */
function keywordScore(word, { title, texts }) {
  if (texts.some((t) => t.includes(word)) || title.slice(0, LEAD_CHARS).includes(word)) return STRONG;
  return title.includes(word) ? WEAK : 0;
}

/** 上级类目名里就有的词（卷纸下的“卷纸”）每个商品都会命中，不算依据 */
function rank(candidates, hints, parent) {
  return candidates
    .map((child) => {
      const words = childKeywords(child).filter((word) => !parent.includes(word));
      const scored = words.map((word) => ({ word, score: keywordScore(word, hints) }));
      const best = scored.sort((a, b) => b.score - a.score)[0] ?? { word: '', score: 0 };
      return { child, score: best.score, hit: best.word };
    })
    .sort((a, b) => b.score - a.score);
}

/** 可以选的子类目：能发布的末级类目，以及还要再往下选的非末级类目（非末级的 publishEnable 总是 false） */
const selectable = (children) => (children ?? []).filter((c) => c && (!c.isLeaf || c.publishEnable !== false));

/**
 * 从子类目里选一个：只有一个可选 → 它；有明确依据且唯一 → 它；否则有常规类目 → 常规类目；
 * 否则只有弱依据且唯一 → 它；都不满足时不猜，返回候选让用户自己指定
 * @param {{id: string, name: string, isLeaf: boolean, publishEnable: boolean, interpretation?: string}[]} children
 * @param {{title: string, texts: string[]}} hints leafHints() 的结果
 * @param {string} [parentName] 上级类目名
 * @returns {{child: object, reason: string} | {child: null, candidates: object[]}}
 */
export function pickLeafChild(children, hints, parentName = '') {
  const candidates = selectable(children);
  if (candidates.length === 1) return { child: candidates[0], reason: '只有这一个可以发布的子类目' };
  if (!candidates.length) return { child: null, candidates };
  const [top, second] = rank(candidates, hints, normalizeName(parentName));
  const unique = top.score > (second?.score ?? -1);
  if (unique && top.score >= STRONG) return { child: top.child, reason: `商品信息里有“${top.hit}”` };
  const general = candidates.find((c) => GENERAL_RE.test(c.name));
  if (general) return { child: general, reason: '商品信息里没有更具体的子类目特征，用常规类目' };
  if (unique && top.score > 0) return { child: top.child, reason: `标题里有“${top.hit}”` };
  return { child: null, candidates };
}
