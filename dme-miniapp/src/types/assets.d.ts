/**
 * types/assets.d.ts - 静态资源 import 的类型声明。
 *
 * Taro 构建会把 import 进来的图片经 url-loader 拷贝进产物并返回路径，
 * 但 TS 默认不认识 *.png 模块，需要这里显式声明。
 */

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.jpg' {
  const src: string;
  export default src;
}

declare module '*.jpeg' {
  const src: string;
  export default src;
}

declare module '*.gif' {
  const src: string;
  export default src;
}

declare module '*.svg' {
  const src: string;
  export default src;
}
