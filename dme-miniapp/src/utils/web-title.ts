/**
 * utils/web-title.ts - 页面标题设置。
 *
 * Web 端（H5 编译目标）：写入 document.title，格式 "<标题> - DME"。
 * 小程序端：no-op —— 标题由各页面的 index.config.ts 的
 * navigationBarTitleText 静态决定；需动态改标题时用 Taro.setNavigationBarTitle。
 *
 * ⚠️ 小程序 tsconfig 的 lib 不含 "dom"，因此这里不用 `document` 类型，
 *    而是从 globalThis 上探测（H5 运行时才有）。
 */

/** 探测 H5 的 document（小程序下为 undefined）。 */
function getDocument(): { title: string } | null {
  const g = globalThis as unknown as { document?: { title: string } };
  return g.document ?? null;
}

/** 设置当前页面标题。 */
export function setWebTitle(title: string): void {
  const doc = getDocument();
  if (!doc) return;
  doc.title = title ? `${title} - DME` : 'DME';
}

/** 组件式用法：挂载时设置标题（小程序端自动跳过）。 */
export function useWebTitle(title: string): void {
  setWebTitle(title);
}
