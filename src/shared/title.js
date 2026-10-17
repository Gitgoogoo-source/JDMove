// 标题处理：京东标题按“汉字/全角=2，英文数字=1”计长（纯函数）

const WIDE_RE = /[⺀-鿿가-힯豈-﫿︰-﹏＀-￯　-〿]/;

const charWeight = (ch) => (WIDE_RE.test(ch) ? 2 : 1);

export function weightedLength(text) {
  let n = 0;
  for (const ch of String(text ?? '')) n += charWeight(ch);
  return n;
}

export function truncateWeighted(text, max) {
  let n = 0;
  let out = '';
  for (const ch of String(text ?? '')) {
    const w = charWeight(ch);
    if (n + w > max) break;
    n += w;
    out += ch;
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} raw
 * @param {{removeWords?: string[], prefix?: string, suffix?: string, maxLength?: number}} opts
 */
export function cleanTitle(raw, opts = {}) {
  const { removeWords = [], prefix = '', suffix = '', maxLength = 60 } = opts;
  const words = [...removeWords].filter(Boolean).sort((a, b) => b.length - a.length);
  let main = String(raw ?? '');
  for (const w of words) main = main.replace(new RegExp(escapeRe(w), 'g'), ' ');
  main = main.replace(/\s+/g, ' ').trim();
  const budget = Math.max(0, maxLength - weightedLength(prefix) - weightedLength(suffix));
  return `${prefix}${truncateWeighted(main, budget).trim()}${suffix}`.trim();
}
