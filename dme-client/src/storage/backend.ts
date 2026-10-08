/**
 * storage/backend.ts - 全局存储后端单例。
 *
 * embed 模式（fatesky iframe 内）使用 EmbedStorageBackend：读写经 postMessage
 * 委托给 fatesky 第一方 localStorage（规避 iOS Safari ITP 第三方分区 + 7 天过期）。
 * standalone（独立 web / native）直接使用 AsyncStorage，行为与历史版本一致。
 *
 * isEmbedContext() 在模块加载时求值且 iframe 上下文终身不变，因此无需动态切换。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isEmbedContext } from '../embed/protocol';
import { embedStorageBackend } from '../embed/embed-storage';
import type { StorageBackend } from '../embed/embed-storage';

export type { StorageBackend } from '../embed/embed-storage';

export const storage: StorageBackend = isEmbedContext()
  ? embedStorageBackend
  : AsyncStorage;
