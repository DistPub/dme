/**
 * voice-recorder.web.ts — web 端录音（按住说话，MP3 编码）。
 *
 * 平台层，与小程序 src/platform/recorder.ts 对齐同一组语义化接口：
 *
 *   - `startVoiceRecording()`   开始录音（resolve = 麦克风就绪 / 用户已授权）
 *   - `stopVoiceRecording()`    停止并取回录音（resolve 于编码完成的 Blob）
 *   - `cancelVoiceRecording()`  丢弃当前录音（不 resolve）
 *
 * 编码用 mp3-mediarecorder（vmsg/LAME wasm），需要一个同源 Worker：
 *   public/mp3-recorder-worker.js（由 scripts/build-mp3-worker.mjs 生成）
 *   public/vmsg.wasm
 * 这两个静态资源随 public/ 部署，离线 SW 也能命中（见 workbox.config.js）。
 *
 * Metro 在 web 平台解析 .web.ts，原生端解析 voice-recorder.ts（stub），
 * 因此该文件（及 mp3-mediarecorder 依赖）不会进入原生包。
 */

import { Mp3MediaRecorder } from 'mp3-mediarecorder';

/** 一次录音的结果（tempFilePath 是 blob: URL）。 */
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

/** 麦克风权限状态（'unsupported' = 浏览器不支持 Permissions API，需靠实际请求判断）。 */
export type MicPermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported';

/** 查询麦克风权限状态（不弹窗）。不支持 Permissions API 时返回 'unsupported'。 */
export async function getMicPermissionState(): Promise<MicPermissionState> {
  try {
    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
      return 'unsupported';
    }
    const status = await navigator.permissions.query(
      { name: 'microphone' } as unknown as PermissionDescriptor,
    );
    return status.state === 'granted' || status.state === 'denied' ? status.state : 'prompt';
  } catch {
    return 'prompt';
  }
}

/** 仅用于请求授权（不真正录音）：成功返回 true 并立即释放音轨。失败（拒绝/不支持）返回 false。 */
export async function requestMicPermission(): Promise<boolean> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

type Phase = 'idle' | 'recording';

let recorder: Mp3MediaRecorder | null = null;
let stream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let chunks: Blob[] = [];
let startTime = 0;
let phase: Phase = 'idle';
let autoStopTimer: ReturnType<typeof setTimeout> | null = null;
let stopResolve: ((r: VoiceRecording) => void) | null = null;
let stopReject: ((e: Error) => void) | null = null;
/** 取消标记：onstop 据此决定结果丢弃还是 resolve。 */
let discardPending = false;
/** 60s 到时底层自动停止：结果先暂存，等松手时 stopVoiceRecording 取走。 */
let autoStopped: VoiceRecording | null = null;
/** startVoiceRecording 的 getUserMedia 仍在等待（录音器尚未建好）。 */
let startInFlight = false;
/** 录音器建好前就收到停止/取消：建好后立即停掉，避免麦克风被永久占用。 */
let abortPendingStart = false;

function fail(msg: string): Error {
  return new Error(msg);
}

function cleanup(): void {
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  recorder = null;
}

export function startVoiceRecording(): Promise<void> {
  if (phase !== 'idle') {
    return Promise.reject(fail('已有录音在进行中'));
  }
  startInFlight = true;
  abortPendingStart = false;
  return new Promise<void>((resolve, reject) => {
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => {
        stream = s;
        const Ctor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) {
          throw new Error('当前浏览器不支持 AudioContext');
        }
        audioCtx = new Ctor();
        const worker = new Worker('/mp3-recorder-worker.js');
        recorder = new Mp3MediaRecorder(stream, { worker, audioContext: audioCtx });
        chunks = [];

        // mp3-mediarecorder 的事件通过 event-target-shim 派发，
        // 直接挂 on* 回调即可（dataavailable 与 stop 都源于 Worker 回传）。
        const rec = recorder as unknown as {
          ondataavailable: ((e: { data?: Blob }) => void) | null;
          onstop: (() => void) | null;
          onerror: ((e: { error?: { message?: string } }) => void) | null;
        };
        rec.ondataavailable = (e: { data?: Blob }): void => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        rec.onstop = (): void => {
          const discard = discardPending;
          discardPending = false;
          const blob = new Blob(chunks, { type: 'audio/mpeg' });
          const durationMs = Date.now() - startTime;
          const url = URL.createObjectURL(blob);
          const resolveFn = stopResolve;
          const rejectFn = stopReject;
          stopResolve = null;
          stopReject = null;
          phase = 'idle';
          startInFlight = false;
          cleanup();
          if (discard) {
            // 取消流程：结果直接作废
            URL.revokeObjectURL(url);
            return;
          }
          if (!resolveFn) {
            // 60s 自动停止等场景：没人等着取，先暂存
            autoStopped = { tempFilePath: url, durationMs, size: blob.size };
            return;
          }
          resolveFn({ tempFilePath: url, durationMs, size: blob.size });
        };
        rec.onerror = (e: { error?: { message?: string } }): void => {
          const err = fail(e?.error?.message || '录音失败');
          const rejectFn = stopReject;
          const resolveFn = stopResolve;
          stopResolve = null;
          stopReject = null;
          discardPending = false;
          phase = 'idle';
          startInFlight = false;
          cleanup();
          if (rejectFn) rejectFn(err);
          else if (resolveFn && autoStopped) resolveFn(autoStopped);
        };

        startTime = Date.now();
        phase = 'recording';
        recorder.start();
        autoStopTimer = setTimeout(() => {
          try {
            recorder?.stop();
          } catch {
            // 已停止则忽略
          }
        }, MAX_VOICE_DURATION_MS);
        startInFlight = false;
        // 录音器建好前用户已松手/取消：立即停掉，释放麦克风（避免 iOS 黄点常亮）
        if (abortPendingStart) {
          abortPendingStart = false;
          discardPending = true;
          try {
            recorder.stop();
          } catch {
            // ignore
          }
          reject(fail('录音已取消'));
          return;
        }
        resolve();
      })
      .catch((err: unknown) => {
        phase = 'idle';
        startInFlight = false;
        cleanup();
        reject(err instanceof Error ? err : fail(String(err)));
      });
  });
}

export function stopVoiceRecording(): Promise<VoiceRecording> {
  if (phase === 'idle') {
    // 60s 自动停止场景：结果已暂存，直接取走
    if (autoStopped) {
      const rec = autoStopped;
      autoStopped = null;
      return Promise.resolve(rec);
    }
    // 录音器还在建（getUserMedia 等待中）：标记取消，建好后立即停掉
    if (startInFlight) {
      abortPendingStart = true;
      return Promise.reject(fail('录音已取消'));
    }
    return Promise.reject(fail('没有进行中的录音'));
  }
  return new Promise<VoiceRecording>((resolve, reject) => {
    stopResolve = resolve;
    stopReject = reject;
    try {
      recorder?.stop();
    } catch (e) {
      reject(e instanceof Error ? e : fail(String(e)));
    }
  });
}

export function cancelVoiceRecording(): void {
  const wasRecording = phase !== 'idle';
  if (!wasRecording && autoStopped) {
    URL.revokeObjectURL(autoStopped.tempFilePath);
    autoStopped = null;
    return;
  }
  if (!wasRecording) return;
  discardPending = true;
  stopResolve = null;
  stopReject = null;
  try {
    recorder?.stop();
  } catch {
    // 已停止则忽略
  }
}
