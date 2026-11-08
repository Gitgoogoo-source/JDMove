// 多段数字属性（发布页控件 ShopAttrMultiInputUnit，如湿厕纸「纸张尺寸」长×宽）的取值（纯函数）。
// 发布页存的是 [{name:'长', unit:'mm', value:'200'}, {name:'宽', unit:'mm', value:'140'}]（value 是字符串），
// 弹窗里每段校验“0-999999999.999的数字，最多保留三位小数”（2026-11-09 在 15913 发布页上核对）。
import { toHalfWidth } from './text.js';

/** 同组单位可以互相换算（换算到组内的基准单位） */
export const UNIT_GROUPS = [
  { 天: 1, 日: 1, 个月: 30, 月: 30, 年: 365 },
  { mg: 0.001, 毫克: 0.001, g: 1, 克: 1, kg: 1000, 千克: 1000, 公斤: 1000, 斤: 500 },
  { ml: 1, 毫升: 1, l: 1000, 升: 1000 },
  { mm: 1, 毫米: 1, cm: 10, 厘米: 10, m: 1000, 米: 1000 },
];

const PART_MAX = 999999999.999;
const DECIMALS = 3;

// 只认长度/重量/容量这几组里的单位；长词在前，“mm”不会被认成“m”
const UNIT_WORDS = [...new Set(UNIT_GROUPS.slice(1).flatMap((g) => Object.keys(g)))].sort((a, b) => b.length - a.length);
const UNIT_SRC = `(${UNIT_WORDS.join('|')})(?![a-z])`;
const TOKEN_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:${UNIT_SRC})?`, 'gi');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 属性的各段：模板 / 页面读到的 segments 优先；旧模板只有选项文字（长、宽）时，单位取属性后缀
 * @param {{segments?: {name: string, units: string[]}[], options?: {label: string}[], suffix?: string}} attr
 * @returns {{name: string, units: string[]}[]}
 */
export function numberSegments(attr) {
  if (attr?.segments?.length) return attr.segments;
  const units = attr?.suffix ? [attr.suffix] : [];
  const names = (attr?.options ?? []).map((o) => String(o.label ?? '')).filter(Boolean);
  return names.length ? names.map((name) => ({ name, units })) : [{ name: '', units }];
}

function convert(num, from, to) {
  if (!from || !to) return num;
  const f = from.toLowerCase();
  const t = to.toLowerCase();
  const group = UNIT_GROUPS.find((g) => f in g && t in g);
  return group ? (num * group[f]) / group[t] : num;
}

const formatNum = (n) => String(Math.round(n * 10 ** DECIMALS) / 10 ** DECIMALS);

/** 文字里全部“数字+单位”；没写单位的数字用后面最近的单位（“195*133mm”两段都是 mm） */
function tokensOf(text) {
  const tokens = [...text.matchAll(TOKEN_RE)].map((m) => ({ num: Number(m[1]), unit: m[2] ?? '', at: m.index }));
  let next = '';
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (tokens[i].unit) next = tokens[i].unit;
    else tokens[i] = { ...tokens[i], unit: next };
  }
  return tokens;
}

/** 每段按标签找（“长195mm 宽133mm”）；全部找到才算 */
function labelledTokens(text, tokens, segments) {
  if (segments.some((s) => !s.name)) return null;
  const picked = segments.map((s) => {
    const m = new RegExp(`${escapeRe(s.name)}\\s*[:：]?\\s*(?=\\d)`).exec(text);
    return m ? tokens.find((t) => t.at === m.index + m[0].length) : null;
  });
  return picked.every(Boolean) ? picked : null;
}

/**
 * 把“长195mm 宽133mm”“195*133mm”“20×14cm”换成发布页要的各段值，单位换算到每段的第一个单位
 * @param {unknown} raw
 * @param {{name: string, units: string[]}[]} segments
 * @returns {{name: string, unit: string, value: string}[] | null} 数字不够或超出页面范围时为 null
 */
export function parseNumberParts(raw, segments) {
  const text = toHalfWidth(raw ?? '').trim();
  if (!text || !segments?.length) return null;
  const tokens = tokensOf(text);
  const picked = labelledTokens(text, tokens, segments) ?? (tokens.length >= segments.length ? tokens.slice(0, segments.length) : null);
  if (!picked) return null;
  const out = segments.map((s, i) => {
    const unit = s.units?.[0] ?? '';
    const num = convert(picked[i].num, picked[i].unit, unit);
    return { name: s.name, unit, value: formatNum(num), ok: num >= 0 && num <= PART_MAX };
  });
  return out.every((p) => p.ok) ? out.map(({ name, unit, value }) => ({ name, unit, value })) : null;
}

/**
 * 显示用：“195mm × 133mm”
 * @param {unknown} parts parseNumberParts 的结果
 */
export function formatNumberParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => `${p?.value ?? ''}${p?.unit ?? ''}`).join(' × ');
}
