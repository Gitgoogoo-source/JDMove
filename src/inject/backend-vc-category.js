// 注入到京麦类目选择页（wares-jdm.jd.com/ware/categorySelect，MAIN world）。依赖 backend-core.js 先注入。
// VC 账号的类目页是逐级展开的几列（categoryColumn 组件，props.list 里每项有 id/name/isLeaf/publishEnable/interpretation，
// props.defaultValue 是这一列选中的类目）。数据来自 sff 网关的 getChildCategory，网关要页面自己签名
// （直接请求返回“请求异常 [312]”，2026-11-08 实测），所以按路径逐级点类目，再读组件数据
(() => {
  const NS = window.__JDMOVE__;
  if (!NS || !NS.backend || !NS.backend.__core || NS.backend.__vcCategory) return;
  const B = NS.backend;
  const { qsa, visible, waitFor, walkComponents } = B.util;

  const COLUMN_COMPONENT = 'categoryColumn';
  const ITEM_SEL = '.vc-category-column__name';
  const STEP_TIMEOUT_MS = 8000;

  /** 页面上的各列（按 colIndex 排好）：{colIndex, defaultValue, list} */
  function columns() {
    const out = [];
    walkComponents((c) => {
      if ((c.type.name || c.type.__name) === COLUMN_COMPONENT && c.props) out.push(c.props);
      return false;
    });
    return out.sort((a, b) => a.colIndex - b.colIndex);
  }

  const listOf = (col) => (col && Array.isArray(col.list) ? col.list : []);
  const selectedIn = (col) => (col && col.defaultValue != null ? String(col.defaultValue) : '');

  const brief = (x) => ({
    id: String(x.id),
    name: String(x.name || ''),
    isLeaf: !!x.isLeaf,
    publishEnable: x.publishEnable !== false,
    interpretation: String(x.interpretation || ''),
  });

  /** 第 depth 列选中 id 后，下一列的子类目；连续两次读到同一份列表才算加载完 */
  async function openNode(depth, id) {
    const now = columns();
    if (selectedIn(now[depth]) === id && listOf(now[depth + 1]).length) return listOf(now[depth + 1]);
    const stale = now[depth + 1] ? now[depth + 1].list : null;
    const el = qsa(ITEM_SEL).find((e) => e.id === id && visible(e));
    if (!el) return null;
    el.click();
    let prev = null;
    return waitFor(
      () => {
        const cols = columns();
        const list = cols[depth + 1] ? cols[depth + 1].list : null;
        const loaded = selectedIn(cols[depth]) === id && listOf(cols[depth + 1]).length > 0 && list !== stale;
        const stable = loaded && list === prev;
        prev = loaded ? list : null;
        return stable ? list : null;
      },
      { timeout: STEP_TIMEOUT_MS },
    );
  }

  const fail = (error) => ({ ok: false, error, children: [] });

  /**
   * 按类目ID路径（一级类目起）逐级点开，返回最后一级的子类目
   * @param {{path: Array<string|number>}} input
   * @returns {Promise<{ok: boolean, leaf?: boolean, children: object[], error?: string}>}
   *   leaf：路径最后一级本身就是末级类目（children 为空）
   */
  async function vcChildCategories({ path = [] } = {}) {
    const ids = path.map(String);
    if (!ids.length) return fail('没有类目ID路径');
    for (let depth = 0; depth < ids.length; depth += 1) {
      const id = ids[depth];
      const col = await waitFor(() => (listOf(columns()[depth]).some((x) => String(x.id) === id) ? columns()[depth] : null), {
        timeout: STEP_TIMEOUT_MS,
      });
      if (!col) return fail(`类目选择页第 ${depth + 1} 级里没有类目 ${id}（类目ID路径要从一级类目写起，且类目要在账号的产品线里）`);
      const node = listOf(col).find((x) => String(x.id) === id);
      const last = depth === ids.length - 1;
      if (node.isLeaf) return last ? { ok: true, leaf: true, children: [] } : fail(`${node.name}[${id}] 已经是末级类目，后面不应再有下级`);
      const list = await openNode(depth, id);
      if (!list) return fail(`点开 ${node.name}[${id}] 后没有出现下级类目`);
      if (last) return { ok: true, leaf: false, children: list.map(brief) };
    }
    return fail('类目ID路径无效');
  }

  Object.assign(B, { __vcCategory: true, vcChildCategories });
})();
