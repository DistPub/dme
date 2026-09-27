module.exports = {
  globDirectory: 'dist',
  globPatterns: [
    'index.html',
    'manifest.json',
    'logo.png',
    'canvaskit.wasm',
    'fonts/*.ttf',
    'icons/*.png',
    '_expo/static/js/**/*.js',
    '_expo/static/css/**/*.css',
    '_expo/static/media/**/*',
  ],
  globIgnores: ['sw.js', 'metadata.json', '_headers'],
  // 运行时请求用绝对路径（/fonts/Roboto-Regular.ttf、/canvaskit.wasm），
  // precache URL 必须同为绝对前缀，否则 lookup 失效无法离线命中
  modifyURLPrefix: { '': '/' },
  maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
  swDest: 'dist/sw.js',
  navigateFallback: '/index.html',
  skipWaiting: true,
  clientsClaim: true,
  cleanupOutdatedCaches: true,
};
