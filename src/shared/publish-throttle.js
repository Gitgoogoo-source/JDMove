// 京麦提交接口限流的识别与冷却时间（纯函数）。
// 店铺被限流时 saveProductNew 返回 {"code":201,"bCode":"10003","msg":"操作过于频繁，请稍后再试 <时间>"}，
// 换商品、换标题、换条形码都一样被拒：这时继续发布只会每条都失败，还会留下自动保存的草稿。
// 只见过这一种限流返回，bCode 10003 也可能是别的业务错误：按“过于频繁”的文字判断，不单看错误码
const THROTTLE_TEXT_RE = /过于频繁|频繁操作/;

/**
 * 提交接口返回的 JSON
 * @param {unknown} text
 * @returns {{code: string, bCode: string, msg: string, traceId: string} | null} 不是 JSON 对象时为 null
 */
export function parseSaveResponse(text) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const str = (v) => (v == null ? '' : String(v));
  return { code: str(data.code), bCode: str(data.bCode), msg: str(data.msg ?? data.message), traceId: str(data['dsm-trace-id']) };
}

const isThrottle = (r) => r.code !== '200' && THROTTLE_TEXT_RE.test(r.msg);

/**
 * 提交结果是否是京麦限流：优先看提交接口的返回，拿不到时看页面弹出的提示或确认框
 * @param {{responses?: string[], messages?: string[], confirmText?: string}} input runAction 带回的 saveResponses / messages / confirmText
 * @returns {{message: string, bCode: string, traceId: string} | null}
 */
export function detectSaveThrottle({ responses = [], messages = [], confirmText = '' } = {}) {
  const hit = responses.map(parseSaveResponse).find((r) => r && isThrottle(r));
  if (hit) {
    const detail = [hit.bCode && `bCode ${hit.bCode}`, hit.traceId && `trace-id ${hit.traceId}`].filter(Boolean).join('，');
    return { message: `京麦提交接口限流：${hit.msg || '操作过于频繁'}${detail ? `（${detail}）` : ''}`, bCode: hit.bCode, traceId: hit.traceId };
  }
  const toast = [...messages, confirmText].find((m) => THROTTLE_TEXT_RE.test(m));
  return toast ? { message: `京麦提交接口限流：${toast}`, bCode: '', traceId: '' } : null;
}

/**
 * 限流记录：什么时候被拒、建议冷却到什么时候
 * @returns {{at: number, until: number, message: string}}
 */
export function throttleRecord({ message, now, cooldownMin }) {
  return { at: now, until: now + cooldownMin * 60e3, message };
}

/** 冷却剩余的毫秒数；没有记录或已结束时为 0 */
export function cooldownLeftMs(record, now) {
  return record ? Math.max(0, record.until - now) : 0;
}

const pad = (n) => String(n).padStart(2, '0');
const clock = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 冷却中的提示（任务面板横幅、发布前确认用）；冷却结束后为空串 */
export function cooldownNotice(record, now) {
  if (!cooldownLeftMs(record, now)) return '';
  return `京麦在 ${clock(record.at)} 拒绝提交新商品，建议 ${clock(record.until)} 之后再发布。${record.message}`;
}
