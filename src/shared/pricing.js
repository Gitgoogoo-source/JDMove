// 价格解析与改价规则（纯函数）
import { toHalfWidth } from './text.js';

/**
 * @param {unknown} text
 * @returns {number|null}
 */
export function parsePrice(text) {
  const s = toHalfWidth(text ?? '').replace(/,/g, '');
  const m = s.match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

const round = (v, digits) => {
  const f = 10 ** digits;
  return Math.round(v * f + Number.EPSILON) / f;
};

function applyRounding(value, mode) {
  switch (mode) {
    case 'jiao':
      return round(value, 1);
    case 'yuan':
      return Math.round(value);
    case 'nine': {
      const candidate = Math.floor(value) + 0.9;
      return round(candidate >= value ? candidate : candidate + 1, 1);
    }
    default:
      return round(value, 2);
  }
}

/**
 * 目标售价 = 源价格 × 倍率 + 加价，再按规则取整
 * @param {number|null} source
 * @param {{multiplier?: number, add?: number, rounding?: 'cent'|'jiao'|'yuan'|'nine', minPrice?: number}} rule
 * @returns {number|null}
 */
export function computePrice(source, rule = {}) {
  if (typeof source !== 'number' || !Number.isFinite(source) || source <= 0) return null;
  const multiplier = Number.isFinite(rule.multiplier) ? rule.multiplier : 1;
  const add = Number.isFinite(rule.add) ? rule.add : 0;
  const minPrice = Number.isFinite(rule.minPrice) ? rule.minPrice : 0.01;
  const value = applyRounding(source * multiplier + add, rule.rounding);
  return Math.max(value, minPrice);
}
