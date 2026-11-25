import { brandKey, itemBrand } from '../shared/brand-folders.js';
import { $, h } from './dom.js';
import { renderRow } from './rows.js';

function setSelected(selected, id, checked) {
  if (checked) selected.add(id);
  else selected.delete(id);
}

function updateCheckbox(checkbox, count, total) {
  checkbox.checked = total > 0 && count === total;
  checkbox.indeterminate = count > 0 && count < total;
}

function updateProductCheckboxes(root, selected) {
  for (const row of root.querySelectorAll('tr[data-id]')) {
    $('.task-check', row).checked = selected.has(row.dataset.id);
  }
}

function renderBrandGroup({ key, name, items }, ctx) {
  const body = h('tbody', { class: 'brand-group' });
  const checkbox = h('input', {
    type: 'checkbox',
    'aria-label': `全选品牌组 ${name}`,
    onchange: () => {
      for (const item of items) setSelected(ctx.selected, item.id, checkbox.checked);
      updateProductCheckboxes(body, ctx.selected);
      onProductCheck();
    },
  });
  const count = h('span', { class: 'brand-count' });
  const toggle = h('button', {
    class: 'brand-toggle',
    type: 'button',
    onclick: () => {
      setExpanded(!ctx.expanded.has(key));
      ctx.updateExpandButtons();
    },
  }, h('span', { class: 'brand-chevron', 'aria-hidden': 'true' }), name, count);
  const header = h('tr', { class: 'brand-header' },
    h('td', {}, checkbox),
    h('th', { colSpan: 6, scope: 'rowgroup' }, toggle),
  );
  body.append(header);

  function updateSelection() {
    const checked = items.filter((item) => ctx.selected.has(item.id)).length;
    updateCheckbox(checkbox, checked, items.length);
    count.textContent = `${items.length} 件${checked ? ` · 已选 ${checked} 件` : ''}`;
  }

  function onProductCheck() {
    updateSelection();
    ctx.updateCheckAll();
  }

  // 折叠时只保留组标题，展开时再创建商品行。勾选状态始终记录在商品 ID 上。
  function setExpanded(open) {
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      ctx.expanded.add(key);
      if (body.rows.length > 1) return;
      const rows = document.createDocumentFragment();
      for (const item of items) rows.append(ctx.renderItem(item, onProductCheck));
      body.append(rows);
    } else {
      ctx.expanded.delete(key);
      while (body.lastElementChild !== header) body.lastElementChild.remove();
    }
  }

  updateSelection();
  setExpanded(ctx.expanded.has(key));
  return { key, body, setExpanded, updateSelection };
}

export function createTaskList() {
  const table = $('#itemsTable');
  const uncollected = $('#rows');
  const checkAll = $('#checkAll');
  const expandAll = $('#expandAllBrands');
  const collapseAll = $('#collapseAllBrands');
  const expanded = new Set();
  let groups = [];

  function updateExpandButtons() {
    expandAll.disabled = !groups.some(({ key }) => !expanded.has(key));
    collapseAll.disabled = !groups.some(({ key }) => expanded.has(key));
  }

  function setAllExpanded(open) {
    for (const group of groups) group.setExpanded(open);
    updateExpandButtons();
  }

  expandAll.addEventListener('click', () => setAllExpanded(true));
  collapseAll.addEventListener('click', () => setAllExpanded(false));

  return {
    render(items, selected, rowOptions) {
      function updateCheckAll() {
        const checked = items.filter((item) => selected.has(item.id)).length;
        updateCheckbox(checkAll, checked, items.length);
      }

      function renderItem(item, onCheck) {
        return renderRow(item, {
          ...rowOptions,
          checked: selected.has(item.id),
          onCheck: (id, checked) => {
            setSelected(selected, id, checked);
            onCheck();
          },
        });
      }

      const brands = new Map();
      const looseRows = document.createDocumentFragment();
      for (const item of items) {
        if (!item.product) {
          looseRows.append(renderItem(item, updateCheckAll));
          continue;
        }
        const name = itemBrand(item);
        const key = brandKey(name);
        if (!brands.has(key)) brands.set(key, { key, name, items: [] });
        brands.get(key).items.push(item);
      }

      for (const group of groups) group.body.remove();
      uncollected.replaceChildren(looseRows);
      const ctx = { expanded, selected, renderItem, updateCheckAll, updateExpandButtons };
      groups = [...brands.values()].map((group) => renderBrandGroup(group, ctx));
      table.append(...groups.map(({ body }) => body));

      checkAll.disabled = items.length === 0;
      checkAll.onchange = () => {
        selected.clear();
        if (checkAll.checked) {
          for (const item of items) selected.add(item.id);
        }
        updateProductCheckboxes(table, selected);
        for (const group of groups) group.updateSelection();
        updateCheckAll();
      };
      updateCheckAll();
      updateExpandButtons();
    },
  };
}
