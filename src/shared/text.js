// 文本归一化与相似度工具（纯函数，无浏览器依赖）

const PUNCT_RE = /[\s:：,，.。;；!！?？'"“”‘’`~·•\-_—+=*&^%$#@|\\/()（）\[\]【】{}<>《》、]/g;

export function toHalfWidth(input) {
  return String(input ?? '')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

export function normalizeName(input) {
  return toHalfWidth(input).toLowerCase().replace(PUNCT_RE, '');
}

function bigrams(s) {
  if (s.length < 2) return s ? [s] : [];
  const out = [];
  for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2));
  return out;
}

// Dice 系数，基于归一化后的二元组
export function similarity(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  const pool = [...by];
  let hit = 0;
  for (const g of bx) {
    const idx = pool.indexOf(g);
    if (idx >= 0) {
      hit += 1;
      pool.splice(idx, 1);
    }
  }
  return (2 * hit) / (bx.length + by.length);
}

export function splitValues(input) {
  return String(input ?? '')
    .split(/[,，、/;；|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function firstNumber(input) {
  const m = toHalfWidth(input).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
