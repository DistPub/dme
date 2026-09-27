/**
 * utils/sound.ts - Message notification sound ("嘀嘀嘀").
 *
 * Uses HTML5 <audio> element for iOS Safari compatibility.
 * Web Audio API is too strict on iOS autoplay policy.
 *
 * Strategy (iOS Safari proven):
 * 1. Pre-create <audio> element with beep sound (data URI)
 * 2. On FIRST user gesture (click/touch), play with volume=0.001 to unlock
 * 3. Subsequent plays just reset currentTime and play()
 */

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';

// ---------------------------------------------------------------------------
// Beep parameters
// ---------------------------------------------------------------------------

const BEEP_FREQUENCY = 880; // Hz (A5, clear "ding")
const BEEP_DURATION = 0.08; // seconds per beep
const BEEP_GAP = 0.07; // seconds between beeps
const BEEP_COUNT = 3;
const SAMPLE_RATE = 22050;

// ---------------------------------------------------------------------------
// WAV generation (for native expo-av)
// ---------------------------------------------------------------------------

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

  // RIFF header
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
// Cached WAV file URI for native
// ---------------------------------------------------------------------------

let cachedWavUri: string | null = null;

async function getWavUri(): Promise<string> {
  if (cachedWavUri) return cachedWavUri;

  const base64 = generateBeepWavBase64();
  const uri = `${FileSystem.documentDirectory}dme_beep.wav`;
  await FileSystem.writeAsStringAsync(uri, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  cachedWavUri = uri;
  return uri;
}

// ---------------------------------------------------------------------------
// Web: Web Audio API (iOS Safari friendly)
// ---------------------------------------------------------------------------

let webAudioCtx: AudioContext | null = null;
let webAudioBuffer: AudioBuffer | null = null;
let webAudioUnlocked = false;
let nativeSound: any = null;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

function getWebAudioContext(): AudioContext | null {
  if (webAudioCtx) return webAudioCtx;
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || (window as WebkitWindow).webkitAudioContext;
  if (!Ctor) return null;
  webAudioCtx = new Ctor();
  return webAudioCtx;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function ensureBeepBuffer(ctx: AudioContext): Promise<void> {
  if (webAudioBuffer) return;
  const bytes = base64ToBytes(generateBeepWavBase64());
  const arrayBuffer = new ArrayBuffer(bytes.length);
  new Uint8Array(arrayBuffer).set(bytes);
  webAudioBuffer = await ctx.decodeAudioData(arrayBuffer);
}

/**
 * Unlock audio on first user gesture via Web Audio API.
 * Plays a 1-sample silent buffer — the only reliable Safari unlock.
 */
export function unlockWebAudio(): void {
  if (webAudioUnlocked) return;
  const ctx = getWebAudioContext();
  if (!ctx) return;

  try {
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    const emptySource = ctx.createBufferSource();
    emptySource.buffer = ctx.createBuffer(1, 1, 22050);
    emptySource.connect(ctx.destination);
    emptySource.start(0);
    webAudioUnlocked = true;
    void ensureBeepBuffer(ctx);
  } catch {
    webAudioUnlocked = true;
  }
}

/**
 * Play the "嘀嘀嘀" notification sound.
 */
export async function playMessageSound(): Promise<void> {
  if (Platform.OS === 'web') {
    await playWeb();
  } else {
    await playNative();
  }
}

async function playWeb(): Promise<void> {
  try {
    const ctx = getWebAudioContext();
    if (!ctx) return;
    if (!webAudioUnlocked) return;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    await ensureBeepBuffer(ctx);
    if (!webAudioBuffer) return;
    const source = ctx.createBufferSource();
    source.buffer = webAudioBuffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch (err) {
    console.error('playMessageSound (web):', err);
  }
}

async function playNative(): Promise<void> {
  try {
    const { Audio } = await import('expo-av');

    if (nativeSound) {
      try {
        await nativeSound.unloadAsync();
      } catch {
        /* ignore */
      }
      nativeSound = null;
    }

    const uri = await getWavUri();
    const sound = new Audio.Sound();
    await sound.loadAsync({ uri });
    await sound.setVolumeAsync(0.3);
    await sound.playAsync();

    nativeSound = sound;
    sound.setOnPlaybackStatusUpdate((status: any) => {
      if (status?.didFinish) {
        if (nativeSound) {
          nativeSound.unloadAsync().catch(() => {});
          nativeSound = null;
        }
      }
    });
  } catch (err) {
    console.error('playMessageSound (native):', err);
  }
}