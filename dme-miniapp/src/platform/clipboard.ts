/**
 * platform/clipboard.ts - 剪贴板（替代 expo-clipboard）。
 */
import Taro from '@tarojs/taro';

/** 写入剪贴板。 */
export async function setClipboard(text: string): Promise<void> {
  await Taro.setClipboardData({ data: text });
}

/** 读取剪贴板内容。 */
export async function getClipboard(): Promise<string> {
  const res = await Taro.getClipboardData();
  return res.data ?? '';
}
