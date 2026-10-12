/**
 * utils/format-chat-time.ts - 聊天页时间展示工具。
 *
 * 规则（与讨论结论一致）：
 * - 日期分隔条（day divider）：跨天（含首条）时显示「今天 / 昨天 / M月D日 / Y年M月D日」。
 * - 气泡外时间戳（clock time）：跨天，或与上一条间隔 > 5 分钟时显示，格式 HH:mm。
 * - 暂不做发送者分组。
 *
 * 全部为纯函数，零第三方依赖，miniapp 可平行复用同一套逻辑。
 */

export type Translate = (key: string, params?: Record<string, string | number>) => string;

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_DAY_MS = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 日期分隔条标签：今天 / 昨天 / M月D日 / Y年M月D日 */
export function formatDayDivider(iso: string | undefined, t: Translate): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = startOfDay(new Date());
  const that = startOfDay(d);
  const diffDays = Math.round((today - that) / ONE_DAY_MS);
  if (diffDays === 0) return t('chatview.dayToday');
  if (diffDays === 1) return t('chatview.dayYesterday');
  if (d.getFullYear() === new Date().getFullYear()) {
    return t('chatview.dayThisYear', { M: d.getMonth() + 1, D: d.getDate() });
  }
  return t('chatview.dayOtherYear', { Y: d.getFullYear(), M: d.getMonth() + 1, D: d.getDate() });
}

/** 气泡外时间戳：HH:mm（24 小时制，跨天由日期分隔条承载日期部分） */
export function formatClockTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 是否显示日期分隔条：首条，或与上一条跨天 */
export function shouldShowDayDivider(prevIso: string | undefined, currIso: string | undefined): boolean {
  if (!currIso) return false;
  if (!prevIso) return true;
  const p = new Date(prevIso);
  const c = new Date(currIso);
  if (Number.isNaN(p.getTime()) || Number.isNaN(c.getTime())) return false;
  return startOfDay(p) !== startOfDay(c);
}

/** 是否显示气泡外时间：跨天，或与上一条间隔 >= 5 分钟 */
export function shouldShowTime(prevIso: string | undefined, currIso: string | undefined): boolean {
  if (!currIso) return false;
  if (shouldShowDayDivider(prevIso, currIso)) return true;
  if (!prevIso) return true;
  const diff = new Date(currIso).getTime() - new Date(prevIso).getTime();
  return diff >= FIVE_MINUTES_MS;
}
