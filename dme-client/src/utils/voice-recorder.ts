/**
 * voice-recorder.ts — 原生端 stub（不引入 mp3-mediarecorder）。
 *
 * 与 voice-recorder.web.ts 共享同一组导出（类型 / 常量 / 函数签名），
 * 让 ChatView 在任意平台都能引用而无需关心实现。语音消息按钮仅在 web 端
 * 渲染，原生不会实际调用这些函数；若误调用则直接抛错。
 *
 * 真正的实现见 voice-recorder.web.ts（Metro 在 web 平台解析 .web.ts）。
 */

/** 一次录音的结果（tempFilePath 在 web 端是 blob: URL）。 */
export interface VoiceRecording {
  tempFilePath: string;
  /** 时长（ms）。 */
  durationMs: number;
  /** 字节数。 */
  size: number;
}

/** 录音时长上限（ms），到时底层自动停止。与小程序端保持一致。 */
export const MAX_VOICE_DURATION_MS = 60_000;
/** 语音文件扩展名。 */
export const VOICE_FORMAT_EXT = 'mp3';
/** 语音 MIME 类型（MP3）。 */
export const VOICE_MIME_TYPE = 'audio/mpeg';

export function startVoiceRecording(): Promise<void> {
  return Promise.reject(new Error('语音录音仅在 web 端可用'));
}

export function stopVoiceRecording(): Promise<VoiceRecording> {
  return Promise.reject(new Error('语音录音仅在 web 端可用'));
}

export function cancelVoiceRecording(): void {
  // no-op on native
}

export type MicPermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported';

export function getMicPermissionState(): Promise<MicPermissionState> {
  return Promise.resolve('unsupported');
}

export function requestMicPermission(): Promise<boolean> {
  return Promise.resolve(false);
}
