/**
 * handshake/qr-decode.ts - 从图库选图 + jsQR 解码。
 *
 * Bob 在 Bluesky 看到 Alice 的 mention 通知后，保存 Alice 发的 QR 图片。
 * 在 DME 中选图，用 jsQR 解码出握手数据。
 *
 * 流程：
 *   1. expo-image-picker 打开图库选图
 *   2. 读取图片为 Uint8Array
 *   3. Skia 解码图片，提取 RGBA 像素
 *   4. jsQR 从像素数据中识别 QR 码
 *   5. decodeHandshakeQR 解析握手 payload
 */

import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { Skia, ColorType, AlphaType } from '@shopify/react-native-skia';
import jsQR from 'jsqr';

import type { HandshakePayload } from './handshake';
import { base64urlToBytes } from '../crypto/utils';

/**
 * 打开图库选图，识别 QR 码，返回握手 payload。
 *
 * @returns 解码后的 HandshakePayload，用户取消或未识别到 QR 返回 null
 */
export async function pickAndDecodeQR(): Promise<HandshakePayload | null> {
  // 1. 图库选图
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 1,
    allowsEditing: false,
  });

  if (result.canceled || !result.assets[0]) {
    return null;
  }

  // 2. 读取图片为 Uint8Array
  const uri = result.assets[0].uri;
  let encoded: Uint8Array;
  if (Platform.OS === 'web') {
    const response = await fetch(uri);
    const buffer = await response.arrayBuffer();
    encoded = new Uint8Array(buffer);
  } else {
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const binary = atob(base64);
    encoded = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      encoded[i] = binary.charCodeAt(i);
    }
  }

  // 3. Skia 解码图片
  const data = Skia.Data.fromBytes(encoded);
  const image = Skia.Image.MakeImageFromEncoded(data);
  if (!image) {
    throw new Error('pickAndDecodeQR: Skia 无法解码图片');
  }

  const width = image.width();
  const height = image.height();

  // 4. 提取 RGBA 像素数据
  const pixels = image.readPixels(0, 0, {
    width,
    height,
    colorType: ColorType.RGBA_8888,
    alphaType: AlphaType.Unpremul,
  });
  if (!pixels) {
    throw new Error('pickAndDecodeQR: 无法读取像素数据');
  }

  // jsQR 需要 Uint8ClampedArray
  const rgba = pixels instanceof Uint8ClampedArray
    ? pixels
    : new Uint8ClampedArray(pixels.buffer ?? pixels);

  // 5. jsQR 解码
  const qr = jsQR(rgba, width, height);
  if (!qr || !qr.data) {
    return null;
  }

  // 6. 解析握手 payload
  return decodeHandshakeQR(qr.data);
}

/**
 * 将 base64url 编码的 QR 字符串解码为 HandshakePayload。
 */
export function decodeHandshakeQR(data: string): HandshakePayload {
  const bytes = base64urlToBytes(data);
  const json = new TextDecoder().decode(bytes);
  const payload = JSON.parse(json) as HandshakePayload;

  if (payload.version !== 1) {
    throw new Error(`decodeHandshakeQR: unsupported version ${payload.version}`);
  }
  if (!payload.ephemeralPub || typeof payload.ephemeralPub !== 'string') {
    throw new Error('decodeHandshakeQR: missing or invalid ephemeralPub');
  }
  if (!payload.identityPubHash || typeof payload.identityPubHash !== 'string') {
    throw new Error('decodeHandshakeQR: missing or invalid identityPubHash');
  }
  if (!payload.queueId1 || typeof payload.queueId1 !== 'string') {
    throw new Error('decodeHandshakeQR: missing or invalid queueId1');
  }
  if (!payload.createdAt || typeof payload.createdAt !== 'string') {
    throw new Error('decodeHandshakeQR: missing or invalid createdAt');
  }

  return payload;
}
