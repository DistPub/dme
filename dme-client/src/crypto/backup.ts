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
import type { KeyPackagePoolEntry, Tombstone } from '../storage/db';
import type { GroupInfo } from '../protocol/group-message';

/** PBKDF2 迭代次数。 */
const PBKDF2_ITERATIONS = 100000;
/** 随机 salt 长度（字节）。 */
const SALT_LENGTH = 16;
/** AES-GCM nonce 长度（字节）。 */
const NONCE_LENGTH = 12;

/** 完整备份数据：身份密钥 + MLS 会话 + KeyPackage 池 + 群聊元数据 + 屏蔽列表。 */
export interface FullBackupData {
  /** Ed25519 + X25519 双密钥对。 */
  identity: IdentityKeys;
  /** MLS 会话序列化状态：groupId -> base64url 编码的 group state。 */
  mlsSessions: Record<string, string>;
  /** 本地 KeyPackage 池（未使用的 KeyPackage 列表）。 */
  keyPackagePool: KeyPackagePoolEntry[];
  /** 群聊元数据列表。 */
  groupInfos: GroupInfo[];
  /** 屏蔽的 DID 列表。 */
  blockList: string[];
  /**
   * 每会话最近一次密钥轮换时间戳（groupId -> epoch ms）。恢复时写回本地，
   * 避免多端同时恢复后 lastRotationAt 全部归零、又同时到期撞槽。
   * 旧备份无此字段 → 视为 0（从未轮换，恢复后立即到期，向后兼容）。
   */
  rotationAt?: Record<string, number>;
  /**
   * 账号级 commit 高水位（宣言 v2）：本端已完成的 commit 计数。恢复时写回，
   * commit 前与 PDS 宣言比对检测备份分叉。旧备份无此字段 → 视为 0。
   */
  commitSeq?: number;
  /**
   * 删除墓碑（方案A）：本机已删除会话的标记，随备份携带。备份前做会话
   * 集合比对时，用于区分「本机领先（我删的）」与「本机落后（别人还有）」。
   * 旧备份无此字段 → 视为空。
   */
  tombstones?: Tombstone[];
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
  blockList: string[];
  rotationAt?: Record<string, number>;
  commitSeq?: number;
  tombstones?: Tombstone[];
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
    blockList: data.blockList,
    rotationAt: data.rotationAt,
    commitSeq: data.commitSeq,
    tombstones: data.tombstones,
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
    blockList: obj.blockList ?? [],
    rotationAt: obj.rotationAt,
    commitSeq: obj.commitSeq,
    tombstones: obj.tombstones,
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

/** 覆盖比对失败的错误码（UI 据此提示「先恢复备份」）。 */
export const BACKUP_COVER_DIFF = 'BACKUP_COVER_DIFF';

/**
 * 备份覆盖比对（方案A墓碑）：备份写入前，将云端现有备份的会话集合与
 * 本机比对，防止本机用缺失会话的旧状态覆盖云端新备份（缺口②：宣言
 * 水位只度量 commit，看不见「备份内容变了但水位没动」）。
 *
 * 分支规则：
 *   - 云端有、本机无、本机有墓碑   → 本机领先（我删的），放行；
 *   - 云端有、本机无、本机无墓碑：
 *     · 本机 commitSeq > 云端备份 commitSeq → 云端备份是过期快照（其会话
 *       集合停留在更早的 commit 时期），本机 commit 历史更新，放行覆盖。
 *       与宣言 v2「单调高水位，高水位状态权威」同一仲裁方向。实测死锁：
 *       历史删除（墓碑功能上线前）+ 兄弟端旧状态回写云端 → cloud-only
 *       永远无墓碑 → 拦下引导恢复 → 恢复清掉本机新会话 → 死循环。
 *     · 否则（seq 相等或更低）→ 本机可能落后，抛 BACKUP_COVER_DIFF。
 *   - 本机有、云端无、云端有墓碑   → 其他设备已删除，本机落后，抛 BACKUP_COVER_DIFF；
 *   - 本机有、云端无、云端无墓碑   → 本机领先（新会话），放行（全量收敛负责传播）。
 *
 * @param cloud            - 解密后的云端现有备份（调用方负责先 decrypt）。
 * @param localGroupIds    - 本机当前会话列表。
 * @param localTombstones  - 本机墓碑列表。
 * @param localCommitSeq   - 本机账号级 commit 高水位（旧实现无此参数前默认 0 语义由调用方保证）。
 * @throws Error(BACKUP_COVER_DIFF) 集合分叉且无法用墓碑 / 水位解释时。
 */
export function checkBackupCoverage(
  cloud: FullBackupData,
  localGroupIds: string[],
  localTombstones: Tombstone[],
  localCommitSeq: number,
): void {
  const cloudGroupIds = Object.keys(cloud.mlsSessions);
  const localSet = new Set(localGroupIds);
  const localTombstoned = new Set(localTombstones.map((t) => t.groupId));
  const cloudTombstoned = new Set((cloud.tombstones ?? []).map((t) => t.groupId));
  // 旧备份无 commitSeq 字段 → 视为 0（本机任何 commit 历史都算更新）。
  const cloudCommitSeq = cloud.commitSeq ?? 0;

  for (const gid of cloudGroupIds) {
    if (localSet.has(gid) || localTombstoned.has(gid)) continue;
    if (localCommitSeq > cloudCommitSeq) continue; // 云端备份过期，本机状态更权威
    throw new Error(BACKUP_COVER_DIFF);
  }
  for (const gid of localGroupIds) {
    if (!cloudGroupIds.includes(gid) && cloudTombstoned.has(gid)) {
      throw new Error(BACKUP_COVER_DIFF);
    }
  }
}
