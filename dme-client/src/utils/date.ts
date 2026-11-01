/**
 * utils/date.ts - 救援通道的日期工具。
 *
 * ⚠️ 规则必须与全仓现有代码一致：`new Date().toISOString().slice(0, 10)`
 * （UTC 日期）。救援 queueId 与 message key 都以日期为派生输入，两端
 * 规则不一致 → 派生值分叉 → 解密必失败。
 */

/** 今天（UTC 日期，YYYY-MM-DD）。 */
export function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 昨天（UTC 日期，YYYY-MM-DD）。
 *
 * 用于 welcomeDate 的兜底：老用户没有持久化 welcomeDate 时用「昨天」，
 * 而**不是**「第一条历史消息的日期」——双方本地消息历史不同，兜底值
 * 会分叉。「昨天」纯由本地时钟派生，两端规则一致。
 */
export function getYesterdayDate(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
