// VC 发布页的三处图片：方图 imageList（≤10 张）、透图 transparentImageList（1 张 PNG）、图片信息识别 aiRecImages（≥1 张）。
// 都要经过“图片空间”弹窗：本地上传的图片会自动勾选，已有的图片按文件名点卡片勾选，最后点“确定”写进表单。
// 图片信息识别放好图片后还要点“开始识别”（vcRecognize），否则点“发布商品”会报“请先进行图片识别”。
// 依赖 backend-vc.js 先注入。
(() => {
  const NS = window.__JDMOVE__;
  if (!NS || !NS.backend || !NS.backend.__vc || NS.backend.__vcImages) return;
  const B = NS.backend;
  const { sleep, qsa, visible, textOf, waitFor, click, buttonByText, messages, setNativeValue } = B.util;
  const { componentChain, putFiles, b64ToFile, installUploadCapture } = B.mediaUtil;
  const { aiRecState } = B.vcUtil;

  const UPLOAD_TIMEOUT_MS = 30000;
  const isImageSpace = (d) => visible(d) && /图片空间/.test(textOf(d).slice(0, 40));
  const imageSpaceDialog = () => qsa('.jd-overlay-dialog, .jd-dialog').find(isImageSpace) || null;
  // 图片信息识别的图片存在组件内部（表单值一直是空的，校验时报在 recProduct 上），按显示的缩略图计数
  const AI_REC_FIELD = 'aiRecImages';
  function valueCount(api, field) {
    if (field === AI_REC_FIELD) {
      const root = api.el(field) && api.el(field).$el;
      return root ? qsa('.sortable-list img', root).filter(visible).length : 0;
    }
    return Array.isArray(api.getValue(field)) ? api.getValue(field).length : 0;
  }

  function hover(el) {
    for (const type of ['mouseenter', 'mouseover', 'mousemove']) el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  }

  /** 方图、透图：字段容器里的“上传图片”按钮直接打开图片空间 */
  function uploadButton(api, field) {
    const inst = api.el(field);
    const root = inst && inst.$el;
    return root ? root.querySelector('.vc-image-upload-button') : null;
  }

  /** 图片信息识别：悬停“+”出现“本地上传 / 图片空间 / 截图上传”，点“图片空间” */
  async function openAiRecSpace(api) {
    const inst = api.el(AI_REC_FIELD);
    const root = inst && inst.$el;
    if (!root) return false;
    // “+”是悬停提示的触发器（JdTooltipTrigger），菜单项“图片空间”在弹出的 .jd-popper 里
    const plus = root.querySelector('.shop-img-upload__upload-logo');
    if (!plus) return false;
    plus.scrollIntoView({ block: 'center' });
    hover(plus);
    const entry = await waitFor(
      () => qsa('.jd-popper *').find((e) => visible(e) && !e.children.length && textOf(e) === '图片空间'),
      { timeout: 3000 },
    );
    if (!entry) return false;
    click(entry.parentElement || entry);
    return true;
  }

  async function openImageSpace(api, field) {
    if (imageSpaceDialog()) {
      const cancel = buttonByText('取消', imageSpaceDialog());
      if (cancel) click(cancel);
      await sleep(500);
    }
    if (field === AI_REC_FIELD) {
      if (!(await openAiRecSpace(api))) return null;
    } else {
      const btn = uploadButton(api, field);
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center' });
      click(btn);
    }
    return waitFor(imageSpaceDialog, { timeout: 8000 });
  }

  const cardByName = (dialog, name) =>
    qsa('.dialog-card-item', dialog).find((c) => textOf(c.querySelector('.image-name') || c) === name) || null;

  /** 本地上传：每张传完后等它出现在卡片里并被勾选 */
  async function uploadInto(dialog, images, errors) {
    const captured = installUploadCapture();
    const input = qsa('input[type=file]', dialog).find((i) => componentChain(i, 2).includes('upload-button'));
    if (!input) {
      errors.push('图片空间里找不到“本地上传”');
      return [];
    }
    const urls = [];
    for (const img of images) {
      const startAt = Date.now();
      putFiles(input, [b64ToFile(img)]);
      const hit = await waitFor(() => captured.find((c) => c.name === img.name && c.at >= startAt - 1000), { timeout: UPLOAD_TIMEOUT_MS });
      if (!hit) {
        errors.push(`${img.name} 上传超时 ${messages().join(' ')}`.trim());
        continue;
      }
      urls.push(hit.url);
      const card = await waitFor(() => cardByName(dialog, img.name), { timeout: 8000 });
      if (card && !card.classList.contains('selected')) click(card.querySelector('img') || card);
      await sleep(200);
    }
    return urls;
  }

  /** 按文件名勾选已经在图片空间里的图片（同一次发布里先传过的主图） */
  async function selectByName(dialog, names, errors) {
    for (const name of names) {
      const card = await waitFor(() => cardByName(dialog, name), { timeout: 8000 });
      if (!card) {
        errors.push(`图片空间里没有 ${name}`);
        continue;
      }
      if (!card.classList.contains('selected')) click(card.querySelector('img') || card);
      await sleep(200);
    }
  }

  /**
   * 往一个图片字段放图：先清空，打开图片空间，上传 images 或勾选 names，点“确定”
   * @param {{field: 'imageList'|'transparentImageList'|'aiRecImages', images?: {name: string, mime: string, b64: string}[], names?: string[]}} input
   * @returns {Promise<{ok: boolean, count: number, urls: string[], errors: string[]}>} urls：本次上传得到的 jfs 地址
   */
  async function vcPutImages({ field, images = [], names = [] }) {
    const api = B.getFApi();
    if (!api || !api.fields().includes(field)) return { ok: false, count: 0, urls: [], errors: [`页面没有 ${field} 字段`] };
    if (field !== AI_REC_FIELD) {
      api.setValue(field, []);
      await sleep(300);
    }
    const before = valueCount(api, field);
    const dialog = await openImageSpace(api, field);
    if (!dialog) return { ok: false, count: 0, urls: [], errors: ['图片空间没有打开'] };
    const errors = [];
    const urls = images.length ? await uploadInto(dialog, images, errors) : [];
    if (names.length) await selectByName(dialog, names, errors);
    const ok = buttonByText('确定', dialog);
    if (!ok) errors.push('图片空间里找不到“确定”');
    else click(ok);
    await waitFor(() => !visible(dialog), { timeout: 5000 });
    const want = before + images.length + names.length;
    const count = await waitFor(() => (valueCount(api, field) >= want ? valueCount(api, field) : null), { timeout: 5000 });
    return { ok: !!count && errors.length === 0, count: valueCount(api, field), urls, errors };
  }

  // ---------- 图片信息识别：点“开始识别” ----------
  // 点按钮先弹“请注意”（.ai-fill-msg）：覆盖数据（整页用识别结果覆盖）/ 补充数据（已填的不动，只补空白字段）/ 取消。
  // 这里选“补充数据”，插件已经写好的标题、价格、图片等不会被改。识别失败页面不提示，标记保持未识别
  const RECOGNIZE_TIMEOUT_MS = 60000;
  const CONFIRM_TIMEOUT_MS = 5000;
  const KEEP_FILLED = '补充数据';
  // 识别文案的长度限制（页面规则：汉字和全角符号算 2 个字符；为空可以识别）
  const REC_TEXT_MIN = 8;
  const REC_TEXT_MAX = 200;
  const WIDE_CHAR_RE = /[一-龥　-〿＀-￯]/;
  const recTextLength = (s) => Array.from(s).reduce((n, ch) => n + (WIDE_CHAR_RE.test(ch) ? 2 : 1), 0);

  function fillRecText(root, text) {
    const input = root.querySelector('.recognize-input input, .recognize-input textarea');
    const len = recTextLength(text || '');
    if (!input || len < REC_TEXT_MIN || len > REC_TEXT_MAX) return false;
    setNativeValue(input, text);
    return true;
  }

  /** 识别结束：成功（已识别）；或者见过“识别中”、现在结束了却还没识别 → 失败 */
  async function waitRecognized(api) {
    let sawReload = false;
    const outcome = await waitFor(
      () => {
        const s = aiRecState(api);
        if (!s) return 'gone';
        if (s.reloading) sawReload = true;
        else if (s.recognized) return 'ok';
        else if (sawReload) return 'failed';
        return null;
      },
      { timeout: RECOGNIZE_TIMEOUT_MS, interval: 500 },
    );
    return outcome || 'timeout';
  }

  /**
   * 图片信息识别：填识别文案，点“开始识别”，选“补充数据”，等页面标记为已识别
   * @param {{text?: string}} input text：识别文案（推荐填商品标题；长度不在 8~200 时留空）
   * @returns {Promise<{ok: boolean, already?: boolean, textFilled?: boolean, errors: string[]}>}
   */
  async function vcRecognize({ text = '' } = {}) {
    const api = B.getFApi();
    const state = aiRecState(api);
    if (!state) return { ok: false, errors: ['页面上找不到图片信息识别'] };
    if (state.recognized) return { ok: true, already: true, errors: [] };
    if (!state.images) return { ok: false, errors: ['图片信息识别里还没有图片'] };
    const root = api.el(AI_REC_FIELD).$el;
    const textFilled = fillRecText(root, text);
    await sleep(300);
    const btn = root.querySelector('.recognize-button');
    if (!btn || btn.disabled) return { ok: false, errors: ['“开始识别”按钮不可点'] };
    btn.scrollIntoView({ block: 'center' });
    click(btn);
    const box = await waitFor(() => qsa('.ai-fill-msg').find(visible), { timeout: CONFIRM_TIMEOUT_MS });
    if (!box) return { ok: false, errors: ['点“开始识别”后没有弹出“覆盖/补充数据”的确认', ...messages()] };
    const keep = buttonByText(KEEP_FILLED, box);
    if (!keep) {
      const cancel = buttonByText('取消', box);
      if (cancel) click(cancel);
      return { ok: false, errors: [`确认框里找不到“${KEEP_FILLED}”`] };
    }
    click(keep);
    const outcome = await waitRecognized(api);
    if (outcome === 'ok') {
      await sleep(500); // 等补充的字段渲染完
      return { ok: true, textFilled, errors: [] };
    }
    const reason = { failed: '识别没有成功', timeout: `识别 ${RECOGNIZE_TIMEOUT_MS / 1000} 秒内没有完成`, gone: '识别后页面上找不到图片信息识别' }[outcome];
    return { ok: false, textFilled, errors: [reason, ...messages()] };
  }

  Object.assign(B, { __vcImages: true, vcPutImages, vcRecognize });
})();
