// 测试用的极简 DOM：节点有 tag、class、子节点、input 的 value/placeholder/readOnly；
// 支持“tag.class.class”复合选择器、空格（后代）组合、逗号分组，够注入脚本的 querySelector / closest 用
// shown=false 的节点（和它的后代）不可见；onClick 模拟页面对点击的反应

/** @typedef {{tag: string, classes: Set<string>, children: MiniNode[], parentElement: MiniNode|null, shown: boolean,
 *   ownText: string, placeholder: string, value: string, readOnly: boolean, disabled: boolean, onClick?: (n: MiniNode) => void}} MiniNode */

function parseCompound(sel) {
  const m = sel.match(/^([a-zA-Z]*)((?:\.[\w-]+)*)$/);
  if (!m) throw new Error(`mini-dom 不支持的选择器：${sel}`);
  return { tag: m[1].toUpperCase(), classes: m[2].split('.').filter(Boolean) };
}

const matchesCompound = (node, { tag, classes }) => (!tag || node.tag === tag) && classes.every((c) => node.classes.has(c));

/** node 是否匹配一组后代选择器（从右往左） */
function matchesChain(node, chain, scope) {
  if (!matchesCompound(node, chain[chain.length - 1])) return false;
  let rest = chain.length - 2;
  for (let p = node.parentElement; p && rest >= 0; p = p.parentElement) {
    if (p === scope) break;
    if (matchesCompound(p, chain[rest])) rest -= 1;
  }
  return rest < 0;
}

const parseSelector = (sel) => sel.split(',').map((s) => s.trim().split(/\s+/).map(parseCompound));

export function descendants(node) {
  return node.children.flatMap((k) => [k, ...descendants(k)]);
}

/**
 * @param {string} spec 'div.a.b' / 'input.jd-input__inner'
 * @param {Partial<MiniNode>} [props]
 * @param {MiniNode[]} [kids]
 * @returns {MiniNode}
 */
export function el(spec, props = {}, kids = []) {
  const { tag, classes } = parseCompound(spec);
  const node = {
    tag: tag || 'DIV',
    classes: new Set(classes),
    children: [],
    parentElement: null,
    shown: true,
    ownText: '',
    placeholder: '',
    value: '',
    readOnly: false,
    disabled: false,
    ...props,
  };
  Object.defineProperties(node, {
    textContent: { get: () => [node.ownText, ...node.children.map((k) => k.textContent)].filter(Boolean).join(' ') },
    innerText: { get: () => node.textContent },
    isConnected: { get: () => true },
    offsetParent: { get: () => (isShown(node) ? {} : null) },
    classList: { get: () => ({ contains: (c) => node.classes.has(c), add: (c) => node.classes.add(c), remove: (c) => node.classes.delete(c) }) },
  });
  node.getClientRects = () => (isShown(node) ? [1] : []);
  node.querySelectorAll = (sel) => {
    const chains = parseSelector(sel);
    return descendants(node).filter((d) => chains.some((c) => matchesChain(d, c, node)));
  };
  node.querySelector = (sel) => node.querySelectorAll(sel)[0] ?? null;
  node.closest = (sel) => {
    const chains = parseSelector(sel);
    for (let p = node; p; p = p.parentElement) if (chains.some((c) => matchesChain(p, c, null))) return p;
    return null;
  };
  node.dispatchEvent = () => true;
  node.click = () => node.onClick?.(node);
  node.scrollIntoView = () => {};
  node.append = (...more) => more.forEach((k) => adopt(node, k));
  kids.forEach((k) => adopt(node, k));
  return node;
}

function adopt(parent, kid) {
  kid.parentElement = parent;
  parent.children.push(kid);
}

function isShown(node) {
  for (let p = node; p; p = p.parentElement) if (!p.shown) return false;
  return true;
}

/** 输入框：value 可写 */
export const input = (placeholder, props = {}) => el('input.jd-input__inner', { placeholder, ...props });
