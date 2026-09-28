/** Taro 全局类型（defineAppConfig / definePageConfig）。 */
declare const defineAppConfig: (config: Record<string, unknown>) => Record<string, unknown>;
declare const definePageConfig: (config: Record<string, unknown>) => Record<string, unknown>;

/** 微信小程序全局对象（仅声明本项目用到的 API）。 */
declare const wx: {
  getRandomValues?: (options: {
    length: number;
    success?: (res: { randomValues: ArrayBuffer }) => void;
    fail?: (err: unknown) => void;
    complete?: () => void;
  }) => void;
  scanCode?: (options: Record<string, unknown>) => void;
};
