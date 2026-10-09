/**
 * handshake/invite-shared.ts - QR 渲染共享常量 / 类型（不含任何 Skia 依赖）。
 *
 * web 与 native 两条路径共用，确保模块图里没有任何 `@shopify/react-native-skia`
 * 静态引用，web bundle 因此无需 CanvasKit WASM。
 */

export const QR_MODULE_SIZE = 4;
export const QR_MARGIN_MODULES = 4;

export type BobStatus = 'not_registered' | 'registered_not_friend' | 'already_friend';
