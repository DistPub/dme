/** 共享导航路由参数类型，避免在各屏幕文件中重复定义。 */

export type RootStackParamList = {
  Login: undefined;
  Setup: undefined;
  ChatList: undefined;
  ChatView: { friendDid: string };
  QrDisplay: undefined;
  QrScan: undefined;
  Settings: undefined;
};

/** DID 文档中用于 handle 解析的最小结构。 */
export interface DidDocWithHandle {
  alsoKnownAs?: string[];
}
