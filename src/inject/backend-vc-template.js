// VC 发布页的「上架模板」：把当前类目发布页的表单结构（基本信息字段、商品属性、规格、SKU 表和 SKU属性）
// 读成一份精简 JSON，保存到 templates/vc/ 下，以后同类目上架按模板匹配。
// 数据全部来自页面自己的 form-create 规则（PublishProduct.setupState.fApi），不点开任何抽屉、不改表单。
// 可以单独执行（自带组件遍历），也会挂到 window.__JDMOVE__.backend.vcCaptureTemplate 上。
(() => {
  const NS = (window.__JDMOVE__ = window.__JDMOVE__ || {});
  NS.backend = NS.backend || {};
  if (NS.backend.__vcTemplate) return;

  const TEMPLATE_VERSION = 1;
  // 这些是页面上的说明块/分组容器，不是要填写的字段
  const SKIP_FIELD_RE = /^(tips-|\d+$)/;
  // 这几个字段的选项是按品牌/账号给的（标准产品、ERP 候选人），不属于类目模板
  const BRAND_SPECIFIC = new Set(['skuSpuKeyAttrVal', 'buyerInfo', 'salerInfo']);

  function walk(visit) {
    const host = document.querySelector('#app');
    const app = host && host.__vue_app__;
    if (!app) return;
    const seen = new Set();
    const stack = [app._container._vnode];
    while (stack.length) {
      const v = stack.pop();
      if (!v) continue;
      const c = v.component;
      if (c && !seen.has(c)) {
        seen.add(c);
        if (visit(c) === true) return;
        stack.push(c.subTree);
      }
      if (Array.isArray(v.children)) for (const ch of v.children) if (ch && typeof ch === 'object') stack.push(ch);
      if (v.dynamicChildren) stack.push(...v.dynamicChildren);
      if (v.suspense) stack.push(v.suspense.activeBranch);
    }
  }

  function fApi() {
    let api = null;
    walk((c) => {
      if ((c.type.name || c.type.__name) === 'PublishProduct' && c.setupState && c.setupState.fApi) {
        api = c.setupState.fApi;
        return true;
      }
      return false;
    });
    return api;
  }

  const isRequired = (node) => {
    const p = node.props || {};
    if (p.rule && p.rule.required) return true;
    if (p.required === true) return true;
    if (node.extra && node.extra.required === true) return true;
    return (node.validate || []).some((v) => v && v.required === true);
  };

  /** 选项只留 label/value（value 统一成字符串：页面输入框存的都是文本） */
  const optionsOf = (node) =>
    ((node.props && node.props.options) || [])
      .filter((o) => o && o.label != null)
      .map((o) => ({ label: String(o.label), value: String(o.value ?? o.label) }));

  /** 校验规则里有用的部分：长度、取值范围、正则提示 */
  function limitsOf(node) {
    const out = {};
    const rule = (node.props && node.props.rule) || {};
    if (rule.maxText) out.maxLength = rule.maxText;
    if (rule.max != null) out.max = rule.max;
    for (const v of node.validate || []) {
      if (!v) continue;
      if (v.max != null && out.max == null && out.maxLength == null) out.max = v.max;
      if (v.min != null) out.min = v.min;
      if (v.len != null) out.len = v.len;
      if (v.pattern) out.pattern = String(v.pattern);
    }
    return out;
  }

  function compact(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v == null || v === '' || v === false) continue;
      if (Array.isArray(v) && !v.length) continue;
      if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue;
      out[k] = v;
    }
    return out;
  }

  function fieldOf(node, extra = {}) {
    const p = node.props || {};
    const field = String(node.field ?? '');
    return compact({
      field,
      title: String(node.title || p.title || '').trim(),
      type: node.type,
      required: isRequired(node),
      suffix: p.suffix || '',
      placeholder: typeof p.placeholder === 'string' ? p.placeholder : '',
      ...limitsOf(node),
      options: BRAND_SPECIFIC.has(field) ? [] : optionsOf(node),
      ...extra,
    });
  }

  /** 属性树（商品属性 / SKU属性）：ShopAttrHeader 分组（必填属性/重要属性/其他属性）下面是字段 */
  function attrList(groups) {
    const out = [];
    for (const g of groups || []) {
      const group = String(g.title || '');
      for (const c of g.children || []) out.push(fieldOf(c, { group }));
    }
    return out;
  }

  /** 规格抽屉：每个维度（SaleDimensionContainer）下的结构化字段，组合字段（SaleBaseGroup）带 parts */
  function saleSpec(list) {
    return (list || []).map((dim) => {
      const fields = ((dim.props && dim.props.template) || []).map((f) => {
        const parts = ((f.props && f.props.template) || []).map((x) => fieldOf(x));
        return fieldOf(f, { parts });
      });
      return compact({ field: String(dim.field), title: dim.title, required: isRequired(dim), fields });
    });
  }

  /** SKU 表的列；SKU属性列（skuProps）展开成属性列表 */
  function skuTable(tables) {
    const columns = [];
    let skuProps = [];
    for (const t of tables || []) {
      for (const c of t.children || []) {
        if (c.field === 'skuProps') skuProps = attrList(c.children);
        columns.push(fieldOf(c));
      }
    }
    return { columns, skuProps };
  }

  function currentValue(api, field) {
    try {
      const v = api.getValue(field);
      if (v == null || v === '') return undefined;
      if (typeof v === 'object') return Array.isArray(v) && !v.length ? undefined : v;
      return String(v);
    } catch (e) {
      return undefined;
    }
  }

  /** 基本信息、价格、图片、物流等顶层字段；带上页面初始值（如销售单位、商品包装的默认选项） */
  function baseFields(api) {
    return api
      .fields()
      .filter((f) => !SKIP_FIELD_RE.test(f) && f !== 'skus' && f !== 'productProp')
      .map((f) => {
        const rule = api.getRule(f);
        if (!rule) return null;
        const init = BRAND_SPECIFIC.has(f) || f === 'brandId' ? undefined : currentValue(api, f);
        return fieldOf({ ...rule, field: f }, init === undefined ? {} : { default: init });
      })
      .filter(Boolean);
  }

  function pageCategoryId() {
    return new URLSearchParams(location.search).get('categoryId') || '';
  }

  /**
   * 读当前发布页的模板
   * @returns {{ok: boolean, error?: string, template?: object}}
   */
  function vcCaptureTemplate() {
    if (!/\/vcProductPublish\//.test(location.pathname)) return { ok: false, error: '当前页面不是 VC 发布页' };
    const api = fApi();
    if (!api) return { ok: false, error: '发布页表单未就绪' };
    const skus = api.getRule('skus');
    const prop = api.getRule('productProp');
    if (!skus || !prop) return { ok: false, error: '发布页上没有 SKU 表或商品属性' };
    const sku = skuTable(skus.props.skuTables);
    return {
      ok: true,
      template: {
        version: TEMPLATE_VERSION,
        publishCategoryId: pageCategoryId(),
        capturedAt: new Date().toISOString(),
        baseFields: baseFields(api),
        productProps: attrList(prop.props.template),
        saleSpec: saleSpec(skus.props.saleAttrComponentList),
        skuColumns: sku.columns,
        skuProps: sku.skuProps,
      },
    };
  }

  Object.assign(NS.backend, { __vcTemplate: true, vcCaptureTemplate });
})();
