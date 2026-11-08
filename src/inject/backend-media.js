// VC 发布页：图片上传工具、商品详情、保存草稿（MAIN world）。
// 依赖 backend-core.js 先注入；backend-vc*.js 复用这里的上传工具（mediaUtil）。
(() => {
  const NS = window.__JDMOVE__;
  if (!NS || !NS.backend || NS.backend.__media) return;
  const B = NS.backend;
  const { sleep, qsa, visible, textOf, waitFor, setNativeValue, click, buttonByText, visibleDialogs, messages } = B.util;

  function b64ToFile({ b64, name, mime }) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime || 'image/jpeg' });
  }

  function componentChain(el, depth = 16) {
    const names = [];
    let c = el.__vueParentComponent;
    for (let i = 0; i < depth && c; i += 1) {
      names.push(c.type.name || c.type.__name || '');
      c = c.parent;
    }
    return names;
  }

  function putFiles(input, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 捕获图片空间上传接口的返回（data.imgUrl / data.imgName）
  function installUploadCapture() {
    if (NS.__uploadCapture) return NS.__uploadCapture;
    const captured = [];
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function send(body) {
      this.addEventListener('load', () => {
        try {
          const data = JSON.parse(this.responseText);
          const d = data && data.data;
          if (d && typeof d.imgUrl === 'string' && /^jfs\//.test(d.imgUrl)) captured.push({ name: d.imgName, url: d.imgUrl, at: Date.now() });
        } catch {
          /* 非 JSON 响应忽略 */
        }
      });
      return origSend.call(this, body);
    };
    NS.__uploadCapture = captured;
    return captured;
  }

  // 输入框失焦后页面才把值提交到表单数据，只触发 input 不够
  function commitInput(el, value) {
    setNativeValue(el, value);
    el.dispatchEvent(new Event('blur'));
  }

  // ---------- 商品详情 ----------
  function descriptionSection() {
    return qsa('.shop-editor_content-right, [class*="shop-editor"]').find(visible) || document;
  }

  // 详情编辑模式按单选框的值识别：文字会带角标（如“图文编辑推荐”），值是稳定的
  const DESC_MODE_VALUES = { 图文编辑: 'FLOOR', 代码编辑: 'CODE', 高级编辑: 'ZHUANG_BA' };

  function descModeRadio(label) {
    const radios = qsa('label.jd-radio', descriptionSection()).concat(qsa('label.jd-radio').filter(visible));
    const valueOf = (l) => (l.querySelector('input.jd-radio__original') || {}).value;
    return (
      radios.find((l) => valueOf(l) === DESC_MODE_VALUES[label]) ||
      radios.find((l) => textOf(l).startsWith(label)) ||
      null
    );
  }

  // 图文编辑里有内容时会弹“是否切换…模式？”确认框；页面忙时它会晚几秒才出来，
  // 所以确认框和选中状态放在同一个等待里看，确认框还开着就不算切换完成
  async function switchDescMode(label, { timeout = 8000 } = {}) {
    const radio = descModeRadio(label);
    if (!radio) return false;
    if (radio.classList.contains('is-checked')) return true;
    click(radio);
    let confirmed = false;
    return !!(await waitFor(() => {
      const box = visibleDialogs().find((d) => /切换/.test(textOf(d)));
      if (!box) return radio.classList.contains('is-checked');
      const ok = !confirmed && buttonByText('确定', box);
      if (ok) {
        click(ok);
        confirmed = true;
      }
      return false;
    }, { timeout }));
  }

  async function uploadDetailImages(images) {
    const captured = installUploadCapture();
    if (!(await switchDescMode('图文编辑'))) return { ok: false, error: '无法切换到图文编辑模式', urls: [] };
    const addBtn = await waitFor(() => buttonByText('添加图片', descriptionSection()) || buttonByText('添加图片'));
    if (!addBtn) return { ok: false, error: '找不到“添加图片”按钮', urls: [] };
    click(addBtn);
    const dialog = await waitFor(() => visibleDialogs().find((d) => /图片空间/.test(textOf(d))), { timeout: 8000 });
    if (!dialog) return { ok: false, error: '图片空间未打开', urls: [] };
    const input = await waitFor(() => qsa('input[type=file]').find((i) => componentChain(i, 2).includes('upload-button')));
    const urls = [];
    const errors = [];
    for (const img of images) {
      const startAt = Date.now();
      putFiles(input, [b64ToFile(img)]);
      const hit = await waitFor(() => captured.find((c) => c.name === img.name && c.at >= startAt - 1000), { timeout: 30000 });
      if (hit) urls.push(hit.url);
      else errors.push(`${img.name} 上传超时 ${messages().join(' ')}`.trim());
      await sleep(300);
    }
    const cancel = buttonByText('取消', dialog);
    if (cancel) click(cancel);
    await sleep(500);
    return { ok: urls.length > 0 || images.length === 0, urls, errors };
  }

  function writeEditor(editor, html) {
    editor.focus();
    editor.innerHTML = html;
    for (const t of ['input', 'keyup', 'change']) editor.dispatchEvent(new Event(t, { bubbles: true }));
    editor.dispatchEvent(new FocusEvent('blur'));
  }

  // 条件要连续保持 ms 毫秒才算数：切换模式后京麦会异步重建编辑器、用旧内容覆盖表单值
  async function holdsFor(check, ms, interval = 200) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!check()) return false;
      await sleep(interval);
    }
    return !!check();
  }

  // 代码编辑器的内容由页面同步到表单值 productDesc.notes，保存时提交的是表单值。
  // 切换模式后页面可能还在重建编辑器，刚写进去的内容会被覆盖：每次重试都重新找编辑器，
  // 写进去后还要保持一段时间不被改掉；编辑器始终同步不过去时直接写表单值
  async function setDescriptionHtml(html, { attempts = 3, syncMs = 4000, settleMs = 1500 } = {}) {
    if (!(await switchDescMode('代码编辑'))) return { ok: false, error: '无法切换到代码编辑模式' };
    const api = B.getFApi();
    const firstSrc = ((html.match(/src="([^"]+)"/) || [])[1] || '').replace(/&amp;/g, '&');
    const notes = () => (api.getValue('productDesc') || {}).notes || '';
    const written = () => notes() !== '' && (!firstSrc || notes().includes(firstSrc));
    let editorLength = 0;
    for (let i = 0; i < attempts; i += 1) {
      const editor = await waitFor(() => qsa('.w-e-text').find(visible), { timeout: 5000 });
      if (!editor) return { ok: false, error: '找不到详情编辑器' };
      writeEditor(editor, html);
      editorLength = editor.innerHTML.length;
      if ((await waitFor(written, { timeout: syncMs })) && (await holdsFor(written, settleMs))) return { ok: true, length: notes().length };
    }
    api.setValue('productDesc', Object.assign({}, api.getValue('productDesc'), { notes: html }));
    if (await holdsFor(written, settleMs)) return { ok: true, length: notes().length, direct: true };
    return { ok: false, error: `商品详情没有写进表单（编辑器 ${editorLength} 字符，表单 ${notes().length} 字符）` };
  }

  // ---------- 保存草稿 ----------
  // VC 发布页有“发布商品”和“保存草稿”两个按钮，插件只点“保存草稿”
  const ACTION_BUTTONS = { vc_draft: ['保存草稿'] };
  // 保存成功后页面弹出“保存成功 … 我知道了”，需要点掉才算结束
  const SUCCESS_POPUP_RE = /保存成功|提交成功|发布成功|操作成功/;
  const ACK_LABELS = ['我知道了', '知道了', '确定', '关闭'];

  function ackButton(box) {
    for (const label of ACK_LABELS) {
      const btn = buttonByText(label, box);
      if (btn) return btn;
    }
    return null;
  }

  // 保存草稿的接口（地址里 api=dsm.productbff.product.draft.saveDraftNew）：成功返回 {code:200, data:{draftId}}，
  // 网关拒收时 {code:455/456, msg:"无效的数字/字符串，请核对后再试 [456]"}
  const VC_DRAFT_API_RE = /saveDraftNew/i;
  const draftIdOf = (text) => (String(text || '').match(/"draftId"\s*:\s*"?(\d{6,20})/) || [])[1] || '';
  // 返回了编号但同时标着失败（success:false、4xx/5xx 错误码）不算成功
  const FAILED_BODY_RE = /"success"\s*:\s*false|"code"\s*:\s*"?[45]\d\d\b/;
  // 接口的原始返回带回扩展侧判断（如限流 bCode 10003）；只带回前 2000 个字符
  const SAVE_RESPONSE_MAX = 2000;
  // 接口明确失败（有失败标记或业务错误码 bCode，如限流的 bCode 10003）时的错误文字；看不出失败时为 null
  function saveFailure(text) {
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* 非 JSON 返回只看失败标记 */
    }
    const obj = data && typeof data === 'object' ? data : {};
    const failed = FAILED_BODY_RE.test(text) || (obj.bCode != null && obj.bCode !== '');
    return failed ? String(obj.msg || obj.message || '') : null;
  }

  // 点击期间临时拦截 XHR/fetch 的返回，记下保存草稿接口的结果；结束后 restore() 恢复原来的 XHR/fetch，不长期改动页面
  function installDraftCapture() {
    const drafts = [];
    const restores = [];
    const record = (text, url) => {
      if (!VC_DRAFT_API_RE.test(String(url || ''))) return;
      const t = String(text);
      drafts.push({ at: Date.now(), draftId: draftIdOf(t), failure: saveFailure(t), text: t.slice(0, SAVE_RESPONSE_MAX) });
    };
    if (typeof XMLHttpRequest !== 'undefined') {
      const origSend = XMLHttpRequest.prototype.send;
      restores.push(() => (XMLHttpRequest.prototype.send = origSend));
      XMLHttpRequest.prototype.send = function send(body) {
        this.addEventListener('load', () => {
          try {
            record(this.responseText, this.responseURL);
          } catch {
            /* 非文本响应忽略 */
          }
        });
        return origSend.call(this, body);
      };
    }
    if (typeof window.fetch === 'function') {
      const origFetch = window.fetch;
      restores.push(() => (window.fetch = origFetch));
      window.fetch = function fetchWithCapture(...args) {
        return origFetch.apply(window, args).then((res) => {
          if (/json|text/.test(res.headers.get('content-type') || '')) res.clone().text().then((t) => record(t, res.url), () => undefined);
          return res;
        });
      };
    }
    return { drafts, restore: () => [...restores].reverse().forEach((fn) => fn()) };
  }

  /** 保存草稿接口的返回 → runAction 的结果 */
  function vcDraftResult(draft, url) {
    const ok = draft.failure == null && !!draft.draftId;
    const why = draft.failure || (draft.draftId ? '' : '保存草稿接口没有返回草稿编号');
    return {
      ok,
      messages: ok ? ['草稿已保存'] : [`保存草稿失败：${why}`],
      errors: [],
      confirmText: '',
      url,
      draftId: draft.draftId,
      saveResponses: [draft.text],
    };
  }

  async function runAction(action, opts) {
    const capture = installDraftCapture();
    try {
      return await clickAndWatch(action, opts, capture);
    } finally {
      capture.restore();
    }
  }

  const disabledReason = () => {
    const store = B.pinia() && B.pinia().state.value['publish-product'];
    return (store && store.publishDisabledMsg) || '请检查页面提示';
  };

  // 只认点击之后新出现的提示：页面上可能还留着“批量设置成功”之类的提示，不能当成保存结果
  async function clickAndWatch(action, { timeoutMs = 20000 } = {}, capture = { drafts: [] }) {
    const labels = ACTION_BUTTONS[action];
    if (!labels) return { ok: false, error: `不支持的操作：${action}` };
    const btn = labels.map((l) => buttonByText(l)).find(Boolean);
    if (!btn) return { ok: false, error: `找不到“${labels.join('”或“')}”按钮` };
    const label = textOf(btn);
    if (btn.classList.contains('is-disabled') || btn.disabled) return { ok: false, error: `“${label}”不可用：${disabledReason()}` };
    const startUrl = location.href;
    const preexisting = new Set(messages());
    const seen = new Set();
    const clickedAt = Date.now();
    click(btn);
    const end = Date.now() + timeoutMs;
    let confirmText = '';
    let popupSuccess = false;
    let draft = null;
    while (Date.now() < end) {
      // 按接口返回判断（成功后 100ms 页面就跳到草稿箱，不等弹窗）
      draft = capture.drafts.find((d) => d.at >= clickedAt) || null;
      if (draft) break;
      messages().filter((m) => !preexisting.has(m)).forEach((m) => seen.add(m));
      const box = visibleDialogs().find(
        (d) => d.classList.contains('jd-message-box') || /提示|确认/.test(textOf(d).slice(0, 20)) || SUCCESS_POPUP_RE.test(textOf(d)),
      );
      if (box && SUCCESS_POPUP_RE.test(textOf(box))) {
        seen.add(textOf(box).slice(0, 200));
        const ack = ackButton(box);
        if (ack) click(ack);
        popupSuccess = true;
        break;
      }
      if (box && !confirmText) {
        confirmText = textOf(box).slice(0, 200);
        // 草稿箱满时弹“继续保存”（会删掉最早的一条草稿）：没有“确定”按钮，不点，交给人工
        const ok = buttonByText('确定', box);
        if (ok) click(ok);
      }
      if (location.href !== startUrl) break;
      if ([...seen].some((m) => SUCCESS_POPUP_RE.test(m) || /失败|错误|请/.test(m))) break;
      await sleep(100);
    }
    if (draft) return vcDraftResult(draft, location.href);
    const msgs = [...seen];
    const errors = B.collectErrors();
    const success = popupSuccess || msgs.some((m) => SUCCESS_POPUP_RE.test(m)) || location.href !== startUrl;
    if (!success && !msgs.length && !errors.length) msgs.push(`点击“${label}”后没有看到保存结果`);
    return {
      ok: popupSuccess || (success && errors.length === 0),
      messages: msgs,
      errors,
      confirmText: popupSuccess ? '' : confirmText,
      url: location.href,
      saveResponses: [],
    };
  }

  Object.assign(B, {
    __media: true,
    switchDescMode,
    uploadDetailImages,
    setDescriptionHtml,
    runAction,
    // 给 VC 发布页脚本（backend-vc*.js）复用
    mediaUtil: { componentChain, putFiles, b64ToFile, installUploadCapture, commitInput },
  });
})();
