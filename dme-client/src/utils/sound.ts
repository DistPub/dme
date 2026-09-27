/**
 * utils/sound.ts - Message notification sound ("嘀嘀嘀").
 *
 * Uses HTML5 <audio> element for iOS Safari compatibility.
 * Web Audio API is too strict on iOS autoplay policy.
 *
 * Strategy:
 * 1. Pre-create <audio> element with a short beep sound (data URI)
 * 2. On FIRST user gesture (click/touch), play once to unlock
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
// Web: HTML5 <audio> element (iOS Safari friendly)
// ---------------------------------------------------------------------------

let webAudioEl: HTMLAudioElement | null = null;
let webAudioUnlocked = false;
let nativeSound: any = null;

/** Generate a 1-sample silent WAV as data URI for silent unlock. */
function generateSilentDataUri(): string {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 38, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 22050, true);
  view.setUint32(28, 44100, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, 2, true);
  view.setUint16(44, 0, true);

  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function generateBeepDataUri(): string {
  const base64 = generateBeepWavBase64();
  return `data:audio/wav;base64,${base64}`;
}

/** Get or create the shared <audio> element. */
function getWebAudioElement(): HTMLAudioElement {
  if (!webAudioEl && typeof window !== 'undefined') {
    webAudioEl = new Audio();
    webAudioEl.preload = 'auto';
    webAudioEl.src = generateBeepDataUri();
    webAudioEl.load();
  }
  return webAudioEl!;
}

/**
 * Unlock audio on first user gesture.
 * Call from click/touch/keydown handler.
 * Plays silently (volume=0) on the SAME element used for notifications.
 */
export function unlockWebAudio(): void {
  if (webAudioUnlocked) return;
  const audio = getWebAudioElement();

  try {
    console.log('unlockWebAudio: unlocking with volume=0...');
    audio.volume = 0;
    const playPromise = audio.play();
    if (playPromise) {
      playPromise.then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.volume = 1;
        webAudioUnlocked = true;
        console.log('unlockWebAudio: unlocked');
      }).catch((e) => {
        console.warn('unlockWebAudio: play failed', e);
      });
    }
  } catch (e) {
    console.warn('unlockWebAudio: failed', e);
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
    const audio = getWebAudioElement();

    if (!webAudioUnlocked) {
      console.warn('playWeb: not unlocked yet, cannot play');
      return;
    }

    audio.currentTime = 0;
    await audio.play();
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