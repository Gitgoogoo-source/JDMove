// 极简 DOM 构造工具：所有文本都通过 textContent 写入，避免页面采集内容造成 XSS

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node|string|number|null|undefined|false)} children
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

/** 打开 <dialog>，返回关闭时的 returnValue */
export function openDialog(dialog) {
  document.body.append(dialog);
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        resolve(dialog.returnValue);
        dialog.remove();
      },
      { once: true },
    );
  });
}

/** 仅允许 http(s) 图片地址进入 <img src> */
export function safeImgSrc(url) {
  return /^https:\/\//.test(String(url ?? '')) ? url : '';
}
