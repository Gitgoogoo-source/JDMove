// 价格文字解析（纯函数）
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
