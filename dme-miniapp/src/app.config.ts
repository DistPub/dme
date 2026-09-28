/**
 * app.config.ts - 小程序全局配置。
 *
 * 主包：login / setup / chat-list / settings / block-list / about
 * 分包 pkg-chat：chat-view / qr-scan / qr-display / create-group / group-settings /
 *               dm-settings / image-viewer / video-viewer（加密栈体重大，聊天相关功能后置加载）
 */
export default defineAppConfig({
  pages: [
    'pages/login/index',
    'pages/setup/index',
    'pages/chat-list/index',
    'pages/settings/index',
    'pages/about/index',
    'pages/block-list/index',
  ],
  subPackages: [
    {
      root: 'pages/pkg-chat',
      pages: [
        'chat-view/index',
        'qr-scan/index',
        'qr-display/index',
        'create-group/index',
        'group-settings/index',
        'dm-settings/index',
        'image-viewer/index',
        'video-viewer/index',
      ],
    },
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#ffffff',
    navigationBarTitleText: 'DME',
    navigationBarTextStyle: 'black',
  },
  // 加密栈需要较新基础库（wx.getRandomValues 2.15.0+ / 动态 import 2.17.3+）
  requiredBackgroundModes: [],
  permission: {
    'scope.camera': {
      desc: '用于扫描好友的邀请二维码以建立端到端加密会话',
    },
  },
  lazyCodeLoading: 'requiredComponents',
});
