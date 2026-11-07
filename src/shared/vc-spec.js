// 规格文本拆分（纯函数）：VC 发布页的规格、SKU属性是按类目拆开的结构化字段
// （如“层数 3 层”“单包抽数 100 抽 × 包数 36 包”），源商品只有一段文本“【王牌囤货装】 3层 100抽*36包”

// “数字 + 单位”：单位是一个汉字（层、抽、包、袋…）、“个月”或一串字母（g、ml、L、mm）
const QUANTITY_RE = /(\d+(?:\.\d+)?)\s*(个月|[a-zA-Z]+|[一-龥])/g;
// 规格开头的描述：【王牌囤货装】、[家庭装]
const DESC_RE = /[【[]([^】\]]+)[】\]]/;
const NUMBER_RE = /\d+(?:\.\d+)?/g;

/**
 * @param {unknown} text
 * @returns {{text: string, desc: string, quantities: {value: number, unit: string}[]}}
 */
export function parseSpecText(text) {
  const s = String(text ?? '').trim();
  const desc = (s.match(DESC_RE)?.[1] ?? '').trim();
  const quantities = [...s.matchAll(QUANTITY_RE)].map((m) => ({ value: Number(m[1]), unit: m[2] }));
  return { text: s, desc, quantities };
}

/**
 * 按单位取数量（同一单位出现多次时取第一个），给“包数”“层数”这类带单位的输入框用
 * @param {{value: number, unit: string}[]} quantities
 * @returns {Record<string, string>}
 */
export function quantitiesByUnit(quantities) {
  return (quantities ?? []).reduce((acc, q) => (q.unit in acc ? acc : { ...acc, [q.unit]: String(q.value) }), {});
}

/**
 * 文本里按顺序出现的数字（纸张尺寸“长195mm 宽133mm”→ [195, 133]）
 * @param {unknown} text
 * @returns {number[]}
 */
export function numbersIn(text) {
  return (String(text ?? '').match(NUMBER_RE) ?? []).map(Number);
}
