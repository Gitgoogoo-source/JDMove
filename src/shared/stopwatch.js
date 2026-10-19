// 分段计时（纯函数）：发布结束时把每一步的用时写进日志，便于找出慢在哪里

/**
 * @param {number} ms
 * @returns {string} 不到 1 秒用毫秒（350ms），否则保留一位小数的秒（6.2s）
 */
export function formatDuration(ms) {
  const n = Math.max(0, Math.round(ms));
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

/**
 * @param {() => number} [now]
 */
export function createStopwatch(now = Date.now) {
  const start = now();
  let mark = start;
  let entries = [];
  const add = (label, ms) => {
    entries = [...entries, { label, ms }];
  };
  return {
    /** 记录距上一段结束的用时，并作为下一段的起点 */
    lap(label) {
      const t = now();
      const ms = t - mark;
      mark = t;
      add(label, ms);
      return ms;
    },
    /** 记录与主流程同时进行的后台任务用时，不移动分段起点 */
    record(label, ms) {
      add(label, ms);
    },
    entries: () => entries.map((e) => ({ ...e })),
    summary: () => `${entries.map((e) => `${e.label} ${formatDuration(e.ms)}`).join('，')}；合计 ${formatDuration(now() - start)}`,
  };
}
