/**
 * weapp-qrcode-canvas-2d 类型声明。
 *
 * 该库无自带 .d.ts（dist 是 rollup 打包的 CJS/ESM，未附类型）。
 * 这里只声明我们实际用到的 drawQrcode 参数子集（见库 README）：
 *   await drawQrcode({ canvas, canvasId, width, padding, background, foreground, text })
 *
 * 注意：库内部自行处理 pixelRatio 与 canvas.width/height，
 * 不需要调用方传 ctx / height / x / y。
 */
declare module 'weapp-qrcode-canvas-2d' {
  export interface DrawQrcodeOptions {
    /** canvas 2d 节点（wx.createSelectorQuery().fields({node:true}) 取到的 node）。 */
    canvas: {
      width: number;
      height: number;
      getContext(type: string): unknown;
    };
    /** canvas 节点的 id（wx 下用于兼容旧接口）。 */
    canvasId?: string;
    /** 二维码边长（逻辑 px）。 */
    width: number;
    /** 内边距。 */
    padding?: number;
    background?: string;
    foreground?: string;
    paddingColor?: string;
    /** 二维码内容。 */
    text: string;
    /** 容错级别：L=1, M=0, Q=3, H=2（默认 H）。 */
    correctLevel?: number;
    /** -1 表示自动选择版本。 */
    typeNumber?: number;
    /** 中心叠加图片（logo）。 */
    image?: {
      imageResource: unknown;
      width: number;
      height: number;
      round?: boolean;
    };
  }

  /** 绘制二维码，返回 Promise。 */
  export default function drawQrcode(options: DrawQrcodeOptions): Promise<unknown>;
}
