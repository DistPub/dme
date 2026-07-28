/**
 * crypto/backup.ts - 身份私钥 + MLS 会话状态的密码加密备份。
 *
 * 备份范围：
 *   - 身份密钥（Ed25519 signing + X25519 encryption 双密钥对）
 *   - 所有 MLS 会话序列化状态（每个 groupId -> base64url）
 *   - KeyPackage 池（本地未使用的 KeyPackage 列表）
 *   - 群聊元数据（GroupInfo：名称、成员、状态）
 *
 * 加密方案：
 *   - PBKDF2-SHA256, 100000 iterations, 16B 随机 salt, 派生 32B AES 密钥
 *   - AES-256-GCM, 12B 随机 nonce
 *   - 明文 = JSON 序列化的 FullBackupData（UTF-8 编码）
 *   - 输出格式：base64url( salt(16) + nonce(12) + ciphertext )
 *
 * 密码错误时 gcm.decrypt 会 throw，调用方应捕获并提示用户。
 */

import { gcm } from '@noble/ciphers/aes';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { bytesToBase64url, base64urlToBytes } from './utils';
import type { IdentityKeys } from './identity';
import type { KeyPackagePoolEntry } from '../storage/db';
import type { GroupInfo } from '../protocol/group-message';

/** PBKDF2 迭代次数。 */
const PBKDF2_ITERATIONS = 100000;
/** 随机 salt 长度（字节）。 */
const SALT_LENGTH = 16;
/** AES-GCM nonce 长度（字节）。 */
const NONCE_LENGTH = 12;

/** 完整备份数据：身份密钥 + MLS 会话 + KeyPackage 池 + 群聊元数据。 */
export interface FullBackupData {
  /** Ed25519 + X25519 双密钥对。 */
  identity: IdentityKeys;
  /** MLS 会话序列化状态：groupId -> base64url 编码的 group state。 */
  mlsSessions: Record<string, string>;
  /** 本地 KeyPackage 池（未使用的 KeyPackage 列表）。 */
  keyPackagePool: KeyPackagePoolEntry[];
  /** 群聊元数据列表。 */
  groupInfos: GroupInfo[];
}

/** JSON 序列化时的中间结构（Uint8Array 转 base64url）。 */
interface SerializedBackup {
  identity: {
    signing: { privateKey: string; publicKey: string };
    encryption: { privateKey: string; publicKey: string };
  };
  mlsSessions: Record<string, string>;
  keyPackagePool: KeyPackagePoolEntry[];
  groupInfos: GroupInfo[];
}

/**
 * 将 FullBackupData 序列化为 JSON 字符串。
 * Uint8Array 私钥/公钥转为 base64url 字符串。
 */
function serializeFullBackupData(data: FullBackupData): string {
  const serialized: SerializedBackup = {
    identity: {
      signing: {
        privateKey: bytesToBase64url(data.identity.signing.privateKey),
        publicKey: bytesToBase64url(data.identity.signing.publicKey),
      },
      encryption: {
        privateKey: bytesToBase64url(data.identity.encryption.privateKey),
        publicKey: bytesToBase64url(data.identity.encryption.publicKey),
      },
    },
    mlsSessions: data.mlsSessions,
    keyPackagePool: data.keyPackagePool,
    groupInfos: data.groupInfos,
  };
  return JSON.stringify(serialized);
}

/**
 * 从 JSON 字符串反序列化 FullBackupData。
 * base64url 私钥/公钥转回 Uint8Array。
 */
function deserializeFullBackupData(json: string): FullBackupData {
  const obj = JSON.parse(json) as SerializedBackup;
  return {
    identity: {
      signing: {
        privateKey: base64urlToBytes(obj.identity.signing.privateKey),
        publicKey: base64urlToBytes(obj.identity.signing.publicKey),
      },
      encryption: {
        privateKey: base64urlToBytes(obj.identity.encryption.privateKey),
        publicKey: base64urlToBytes(obj.identity.encryption.publicKey),
      },
    },
    mlsSessions: obj.mlsSessions,
    keyPackagePool: obj.keyPackagePool,
    groupInfos: obj.groupInfos,
  };
}

/**
 * 使用密码加密完整备份数据。
 *
 * @param data     - 要备份的完整数据（身份密钥 + MLS 会话 + KeyPackage 池 + 群聊元数据）。
 * @param password - 用户密码。
 * @returns base64url 编码的密文（salt || nonce || ciphertext）。
 */
export function encryptBackup(data: FullBackupData, password: string): string {
  const json = serializeFullBackupData(data);
  const plaintext = utf8ToBytes(json);

  // 生成随机 salt 和 nonce
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));

  // PBKDF2-SHA256 派生 AES 密钥
  const key = pbkdf2(sha256, password, salt, { c: PBKDF2_ITERATIONS, dkLen: 32 });

  // AES-256-GCM 加密（gcm.encrypt 自动附加 16B tag）
  const ciphertext = gcm(key, nonce).encrypt(plaintext);

  // 拼接 salt || nonce || ciphertext
  const output = new Uint8Array(SALT_LENGTH + NONCE_LENGTH + ciphertext.length);
  output.set(salt, 0);
  output.set(nonce, SALT_LENGTH);
  output.set(ciphertext, SALT_LENGTH + NONCE_LENGTH);

  return bytesToBase64url(output);
}

/**
 * 使用密码解密完整备份数据。
 *
 * @param encryptedData - base64url 编码的密文（salt || nonce || ciphertext）。
 * @param password      - 用户密码。
 * @returns 解密后的 FullBackupData。
 * @throws 密码错误时 gcm.decrypt 会抛出错误。
 */
export function decryptBackup(encryptedData: string, password: string): FullBackupData {
  const data = base64urlToBytes(encryptedData);

  if (data.length < SALT_LENGTH + NONCE_LENGTH + 1) {
    throw new Error(
      `decryptBackup: data too short (${data.length} bytes)`,
    );
  }

  const salt = data.slice(0, SALT_LENGTH);
  const nonce = data.slice(SALT_LENGTH, SALT_LENGTH + NONCE_LENGTH);
  const ciphertext = data.slice(SALT_LENGTH + NONCE_LENGTH);

  // PBKDF2-SHA256 派生 AES 密钥
  const key = pbkdf2(sha256, password, salt, { c: PBKDF2_ITERATIONS, dkLen: 32 });

  // AES-256-GCM 解密（gcm.decrypt 验证 tag，失败时 throw）
  const plaintext = gcm(key, nonce).decrypt(ciphertext);

  const json = new TextDecoder().decode(plaintext);
  return deserializeFullBackupData(json);
}
