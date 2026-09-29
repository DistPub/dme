/**
 * platform/recorder.ts - 录音平台层（按住说话）。
 *
 * 封装 `wx.getRecorderManager()`（Taro.getRecorderManager，全局单例），
 * 给 chat-view 的「按住说话」按钮提供三个语义化方法：
 *
 *   - `startVoiceRecording()`   开始录音（resolve 于 onStart，即麦克风真正就绪；
 *                               用户拒绝授权 / 被占用等在 onError reject）
 *   - `stopVoiceRecording()`    停止并取回录音文件（resolve 于 onStop；
 *                               🔴 允许在 start 尚未 resolve 时调用——
 *                               极短按场景会先等 onStart 再立即 stop）
 *   - `cancelVoiceRecording()`  丢弃当前录音（onStop 的临时文件直接作废）
 *
 * 状态机（模块级单例，与 RecorderManager 全局单例一一对应）：
 *
 *   idle ──start()──▶ starting ──onStart──▶ recording ──stop()──▶ stopping
 *                      │                       │                     │
 *                   onError                 cancel()              onStop
 *                      ▼                       ▼                     ▼
 *                  reject start            stopping(丢弃)         resolve
 *                                                                      │
 *                                              onError ──────────▶ reject
 *
 * 平台要点：
 *   - RecorderManager 的事件监听**会累积**（每次 onStop 都是 addListener），
 *     所以监听器只在首次获取 manager 时注册一次，回调里读模块级状态分发，
 *     绝不在每次 start() 里重复挂监听。
 *   - 录音参数：aac / 16kHz / 单声道 / 48kbps——语音消息标准配置，
 *     60s 上限到时底层自动 onStop（等价用户松手）。
 *   - 录音临时文件在 onStop 结果里给出（tempFilePath + duration + fileSize），
 *     发送侧直接交 `sendFileMessage`（内部 copyIntoCache 会复制进缓存目录，
 *     不依赖这个临时路径的存活期）。
 */

import Taro from '@tarojs/taro';

/** 一次录音的结果。 */
export interface VoiceRecording {
  tempFilePath: string;
  /** 时长（ms）。 */
  durationMs: number;
  /** 字节数。 */
  size: number;
}

/** 录音配置常量（chat-view UI 也引用 MAX_VOICE_DURATION_MS 做倒计时）。 */
export const MAX_VOICE_DURATION_MS = 60_000;
export const VOICE_FORMAT_EXT = 'aac';
export const VOICE_MIME_TYPE = 'audio/aac';

type Phase = 'idle' | 'starting' | 'recording' | 'stopping';

let manager: Taro.RecorderManager | null = null;
let phase: Phase = 'idle';
/** cancel 标记：stopping 阶段据此决定 onStop 的文件是 resolve 还是丢弃。 */
let discardPendingStop = false;
/** starting 阶段被 stop()/cancel()：等 onStart 后立即执行。 */
let pendingAction: 'stop' | 'cancel' | null = null;

let startResolve: (() => void) | null = null;
let startReject: ((err: Error) => void) | null = null;
let stopResolve: ((rec: VoiceRecording) => void) | null = null;
let stopReject: ((err: Error) => void) | null = null;
/** 60s 到时底层自动 onStop 的结果：此时没人调用 stop()，先暂存供后续取用。 */
let autoStoppedRecording: VoiceRecording | null = null;

function fail(errMsg: string): Error {
  return new Error(errMsg || '录音失败');
}

/** 首次调用时创建全局 manager 并挂好一次性监听器。 */
function getManager(): Taro.RecorderManager {
  if (manager) return manager;
  const mgr = Taro.getRecorderManager();

  mgr.onStart(() => {
    if (phase !== 'starting') return;
    phase = 'recording';
    const resolve = startResolve;
    startResolve = null;
    startReject = null;
    resolve?.();
    // 极短按：start 还没完成用户就松手了 → 立即收尾
    if (pendingAction === 'stop') {
      pendingAction = null;
      phase = 'stopping';
      mgr.stop();
    } else if (pendingAction === 'cancel') {
      pendingAction = null;
      discardPendingStop = true;
      phase = 'stopping';
      mgr.stop();
    }
  });

  mgr.onStop((res) => {
    const discard = discardPendingStop;
    discardPendingStop = false;
    const resolve = stopResolve;
    const reject = stopReject;
    stopResolve = null;
    stopReject = null;
    phase = 'idle';
    if (!resolve && !reject) {
      // 60s 到时自动停止：暂存结果，等用户松手时 stopVoiceRecording 取走
      if (!discard) {
        autoStoppedRecording = {
          tempFilePath: res.tempFilePath,
          durationMs: res.duration,
          size: res.fileSize,
        };
      }
      return;
    }
    if (discard) {
      reject?.(fail('录音已取消'));
      return;
    }
    resolve?.({
      tempFilePath: res.tempFilePath,
      durationMs: res.duration,
      size: res.fileSize,
    });
  });

  mgr.onError((res) => {
    const err = fail(res?.errMsg ?? '录音失败');
    if (phase === 'starting') {
      phase = 'idle';
      const reject = startReject;
      startResolve = null;
      startReject = null;
      pendingAction = null;
      reject?.(err);
    } else if (phase === 'recording' || phase === 'stopping') {
      phase = 'idle';
      discardPendingStop = false;
      const reject = stopReject;
      stopResolve = null;
      stopReject = null;
      reject?.(err);
    }
  });

  manager = mgr;
  return mgr;
}

/**
 * 开始录音。resolve = onStart（麦克风真正开始采集）；reject = onError
 * （用户拒绝授权、被其他应用占用等，errMsg 已归一化）。
 */
export function startVoiceRecording(): Promise<void> {
  if (phase !== 'idle') {
    return Promise.reject(fail('已有录音在进行中'));
  }
  const mgr = getManager();
  phase = 'starting';
  const promise = new Promise<void>((resolve, reject) => {
    startResolve = resolve;
    startReject = reject;
  });
  try {
    mgr.start({
      duration: MAX_VOICE_DURATION_MS,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: 'aac',
    });
  } catch (err) {
    phase = 'idle';
    startResolve = null;
    startReject = null;
    return Promise.reject(err instanceof Error ? err : fail(String(err)));
  }
  return promise;
}

/**
 * 停止录音并取回文件。
 * 🔴 允许在 starting 阶段调用（极短按）：内部等 onStart 后立即 stop。
 * reject：onError（含取消流程被打断）、或上一次 cancel 的占位。
 */
export function stopVoiceRecording(): Promise<VoiceRecording> {
  if (phase === 'idle') {
    // 60s 自动停止场景：结果已暂存，直接取走
    if (autoStoppedRecording) {
      const rec = autoStoppedRecording;
      autoStoppedRecording = null;
      return Promise.resolve(rec);
    }
    return Promise.reject(fail('没有进行中的录音'));
  }
  if (phase === 'starting') {
    pendingAction = 'stop';
    return new Promise<VoiceRecording>((resolve, reject) => {
      stopResolve = resolve;
      stopReject = reject;
    });
  }
  if (phase === 'stopping') {
    // 60s 自动停止等场景：stopping 已在进行，直接接当前的 promise
    return new Promise<VoiceRecording>((resolve, reject) => {
      stopResolve = resolve;
      stopReject = reject;
    });
  }
  phase = 'stopping';
  return new Promise<VoiceRecording>((resolve, reject) => {
    stopResolve = resolve;
    stopReject = reject;
    manager?.stop();
  });
}

/** 丢弃当前录音（onStop 结果作废，promise reject '录音已取消'）。 */
export function cancelVoiceRecording(): void {
  if (phase === 'idle') return;
  if (phase === 'starting') {
    pendingAction = 'cancel';
    // starting 阶段可能已有人调过 stop()（极短按）：把它的 promise 也收尾
    stopResolve = null;
    stopReject?.(fail('录音已取消'));
    stopReject = null;
    return;
  }
  if (phase === 'stopping') {
    discardPendingStop = true;
    return;
  }
  phase = 'stopping';
  discardPendingStop = true;
  manager?.stop();
}
