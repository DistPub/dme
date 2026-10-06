import Taro from '@tarojs/taro';

// ---------------------------------------------------------------------------
// Beep parameters（与 dme-client/src/utils/sound.ts 完全一致）
// ---------------------------------------------------------------------------

const BEEP_FREQUENCY = 880; // Hz
const BEEP_DURATION = 0.08; // seconds per beep
const BEEP_GAP = 0.07; // seconds between beeps
const BEEP_COUNT = 3;
const SAMPLE_RATE = 22050;

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export function generateBeepWavBase64(): string {
  const totalDuration = BEEP_COUNT * (BEEP_DURATION + BEEP_GAP) - BEEP_GAP;
  const numSamples = Math.floor(SAMPLE_RATE * totalDuration);
  const dataSize = numSamples * 2;

  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  const beepPeriod = BEEP_DURATION + BEEP_GAP;
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const beepIndex = Math.floor(t / beepPeriod);
    const offsetInBeep = t - beepIndex * beepPeriod;

    let sample = 0;
    if (offsetInBeep < BEEP_DURATION && beepIndex < BEEP_COUNT) {
      const attack = Math.min(1, offsetInBeep * 60);
      const decay = Math.min(1, (BEEP_DURATION - offsetInBeep) * 60);
      const envelope = attack * decay;
      sample = 0.3 * envelope * Math.sin(2 * Math.PI * BEEP_FREQUENCY * t);
    }

    view.setInt16(offset, Math.max(-1, Math.min(1, sample)) * 0x7fff, true);
    offset += 2;
  }

  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Cached WAV file in USER_DATA_PATH
// ---------------------------------------------------------------------------

let cachedWavPath: string | null = null;

function userDataPath(): string | null {
  const path = Taro.env?.USER_DATA_PATH;
  if (!path) {
    console.error('[dme:sound] Taro.env.USER_DATA_PATH 不可用');
    return null;
  }
  return path;
}

function writeWavFile(): string | null {
  if (cachedWavPath) return cachedWavPath;
  const basePath = userDataPath();
  if (!basePath) return null;

  try {
    const fs = Taro.getFileSystemManager();
    const path = `${basePath}/dme_beep.wav`;
    fs.writeFileSync(path, generateBeepWavBase64(), 'base64');
    cachedWavPath = path;
    console.log('[dme:sound] 提示音文件已写入', path);
    return path;
  } catch (err) {
    console.error('[dme:sound] 写入提示音文件失败:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Miniapp audio unlock / play
// ---------------------------------------------------------------------------

let audioUnlocked = false;

function createSoundContext(path: string, volume: number): Taro.InnerAudioContext | null {
  if (typeof Taro.createInnerAudioContext !== 'function') {
    console.error('[dme:sound] Taro.createInnerAudioContext 不可用');
    return null;
  }
  try {
    const ctx = Taro.createInnerAudioContext();
    ctx.src = path;
    ctx.volume = volume;
    return ctx;
  } catch (err) {
    console.error('[dme:sound] 创建 InnerAudioContext 失败:', err);
    return null;
  }
}

function cleanup(ctx: Taro.InnerAudioContext): void {
  try {
    ctx.destroy();
  } catch {
    /* ignore */
  }
}

export function unlockMiniappAudio(): void {
  console.log('[dme:sound] unlockMiniappAudio 被调用，当前 unlocked=', audioUnlocked);
  if (audioUnlocked) return;

  const path = writeWavFile();
  if (!path) return;

  const ctx = createSoundContext(path, 0.001);
  if (!ctx) return;

  ctx.onCanplay(() => {
    console.log('[dme:sound] unlock onCanplay');
    ctx.play();
  });
  ctx.onPlay(() => {
    console.log('[dme:sound] unlock onPlay');
    audioUnlocked = true;
    cleanup(ctx);
  });
  ctx.onError((err) => {
    console.error('[dme:sound] unlock onError:', err);
    cleanup(ctx);
  });
  ctx.onStop(() => cleanup(ctx));
  ctx.onEnded(() => {
    console.log('[dme:sound] unlock onEnded');
    audioUnlocked = true;
    cleanup(ctx);
  });
}

export function playMessageSound(): void {
  console.log('[dme:sound] playMessageSound 被调用，当前 unlocked=', audioUnlocked);
  if (!audioUnlocked) return;

  const path = writeWavFile();
  if (!path) return;

  const ctx = createSoundContext(path, 0.3);
  if (!ctx) return;

  ctx.onCanplay(() => {
    console.log('[dme:sound] play onCanplay');
    ctx.play();
  });
  ctx.onPlay(() => {
    console.log('[dme:sound] play onPlay');
  });
  ctx.onEnded(() => cleanup(ctx));
  ctx.onError((err) => {
    console.error('[dme:sound] play onError:', err);
    cleanup(ctx);
  });
  ctx.onStop(() => cleanup(ctx));
}

export function getIsAudioUnlocked(): boolean {
  return audioUnlocked;
}
