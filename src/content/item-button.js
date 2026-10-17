// 商品详情页右下角的“搬运此商品”按钮（isolated world）
(() => {
  if (document.getElementById('jdmove-fab')) return;

  const fab = document.createElement('div');
  fab.id = 'jdmove-fab';
  fab.innerHTML = '<button type="button" class="jdmove-btn">搬运此商品</button><div class="jdmove-toast" hidden></div>';
  document.documentElement.appendChild(fab);

  const btn = fab.querySelector('.jdmove-btn');
  const toast = fab.querySelector('.jdmove-toast');

  const show = (msg, kind) => {
    toast.textContent = msg;
    toast.dataset.kind = kind;
    toast.hidden = false;
    clearTimeout(show.timer);
    show.timer = setTimeout(() => {
      toast.hidden = true;
    }, 6000);
  };

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '采集中…';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'collect-tab' });
      if (res?.ok) {
        const warn = res.warnings?.length ? `（注意：${res.warnings.join('、')}）` : '';
        show(`已加入任务面板：${res.title}${warn}`, res.warnings?.length ? 'warn' : 'ok');
      } else {
        show(`采集失败：${res?.error ?? '未知错误'}`, 'error');
      }
    } catch (e) {
      show(`采集失败：${e.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '搬运此商品';
    }
  });
})();
