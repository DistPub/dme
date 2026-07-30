/**
 * utils/sound.ts - Message notification sound ("嘀嘀嘀").
 *
 * Generates a short 3-beep WAV at runtime and plays it.
 * Web: Web Audio API oscillator (no file needed).
 * Native: writes WAV to temp file, plays via expo-av.
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
// WAV generation
// ---------------------------------------------------------------------------

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/** Generate a 3-beep WAV file as a base64 string. */
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
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // audio format (PCM)
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Generate samples
  let offset = 44;
  const beepPeriod = BEEP_DURATION + BEEP_GAP;
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const beepIndex = Math.floor(t / beepPeriod);
    const offsetInBeep = t - beepIndex * beepPeriod;

    let sample = 0;
    if (offsetInBeep < BEEP_DURATION && beepIndex < BEEP_COUNT) {
      // Exponential attack/decay envelope for clean "ding"
      const attack = Math.min(1, offsetInBeep * 60);
      const decay = Math.min(1, (BEEP_DURATION - offsetInBeep) * 60);
      const envelope = attack * decay;
      sample = 0.3 * envelope * Math.sin(2 * Math.PI * BEEP_FREQUENCY * t);
    }

    view.setInt16(offset, Math.max(-1, Math.min(1, sample)) * 0x7fff, true);
    offset += 2;
  }

  // Convert to base64
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
// Playback
// ---------------------------------------------------------------------------

let webAudioCtx: AudioContext | null = null;
let nativeSound: any = null;

/**
 * Play the "嘀嘀嘀" notification sound.
 * Call this when a new message arrives and the sound should be heard.
 */
export async function playMessageSound(): Promise<void> {
  if (Platform.OS === 'web') {
    playWeb();
  } else {
    await playNative();
  }
}

function playWeb(): void {
  try {
    const AudioContextClass =
      (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!AudioContextClass) {
      console.error('playMessageSound: Web Audio API not supported');
      return;
    }

    // Close any previous context
    if (webAudioCtx) {
      try {
        webAudioCtx.close();
      } catch {
        /* already closed */
      }
    }
    webAudioCtx = new AudioContextClass();
    const ctx = webAudioCtx;

    for (let i = 0; i < BEEP_COUNT; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = BEEP_FREQUENCY;
      osc.type = 'sine';
      osc.connect(gain);
      gain.connect(ctx.destination);

      const start = ctx.currentTime + i * (BEEP_DURATION + BEEP_GAP);
      const end = start + BEEP_DURATION;
      osc.start(start);
      osc.stop(end);
      gain.gain.setValueAtTime(0.3, start);
      gain.gain.exponentialRampToValueAtTime(0.001, end);
    }

    // Clean up after playback
    setTimeout(() => {
      if (webAudioCtx) {
        try {
          webAudioCtx.close();
        } catch {
          /* already closed */
        }
        webAudioCtx = null;
      }
    }, 1000);
  } catch (err) {
    console.error('playMessageSound (web):', err);
  }
}

async function playNative(): Promise<void> {
  try {
    const { Audio } = await import('expo-av');

    // Unload previous sound
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
