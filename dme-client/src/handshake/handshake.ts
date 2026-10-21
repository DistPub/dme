/**
 * handshake/handshake.ts - MLS-based QR handshake orchestration.
 *
 * Replaces the old X3DH handshake with MLS group creation + Welcome
 * delivery. Three entry points cover the full invite flow:
 *
 *   prepareInviteQr  (Alice) - generate QR with encrypted KeyPackage
 *   acceptInvite     (Bob)   - scan QR, create MLS group, emit Welcome
 *   processWelcome   (Alice) - join MLS group from received Welcome
 *
 * Flow:
 *   Alice: prepareInviteQr -> QR code posted to Bluesky
 *   Bob:   acceptInvite    -> MLS group created, Welcome stored on PDS
 *   Alice: processWelcome  -> joins group via Welcome from PDS
 *
 * The groupId returned by each function is the friend's DID, used as
 * the storage key for MLS session persistence (consistent with how
 * messages are stored by friendDid in DmeStorage).
 */

import { decodeMlsMessage, type KeyPackage, type PrivateKeyPackage, type Welcome } from 'ts-mls';

import type { IdentityKeys } from '../crypto/identity';
import type { KeyPackagePair } from '../crypto/keypackage';
import { MlsSession } from '../crypto/mls-session';
import { createDidCredential } from '../crypto/mls-credential';
import { deriveWelcomeQueueId } from '../crypto/mls-queue-id';
import { getNobleMlsImpl } from '../crypto/mls-noble-kdf';
import {
  encryptKeyPackage,
  serializeEncryptedKeyPackage,
} from '../crypto/keypackage';
import { bytesToBase64url } from '../crypto/utils';
import { encodeQrPayload } from './qr-encode';
import { decodeAndDecryptQr } from './qr-decode';

/**
 * Alice-side: Generate the QR payload containing her encrypted KeyPackage.
 *
 * Steps:
 *   1. Encrypt the provided KeyPackage (from the KP pool) with Bob's X25519
 *      public key
 *   2. Serialize the encrypted KeyPackage to bytes
 *   3. Encode as QR string
 *
 * KP 池统一消费（rotation-baseline-plan.md 3.2）：pair 由调用方从池内取
 * （新鲜度受控），本函数不再现场生成。当前无调用方（UI 走 AppContext
 * generateInviteQr），保留为协议完整性入口。
 *
 * @param aliceDid               - Alice's DID.
 * @param keyPackagePair         - Alice's KeyPackage pair (from the KP pool).
 * @param bobEncryptionPublicKey - Bob's X25519 public key from DID document.
 * @returns QR string and Alice's KeyPackage initKey (for Welcome queueId polling).
 */
export async function prepareInviteQr(
  aliceDid: string,
  keyPackagePair: KeyPackagePair,
  bobEncryptionPublicKey: Uint8Array,
): Promise<{ qrString: string; keyPackageInitKey: Uint8Array }> {
  const encrypted = await encryptKeyPackage(
    keyPackagePair.publicPackage,
    bobEncryptionPublicKey,
  );

  const encryptedKeyPackage = serializeEncryptedKeyPackage(
    encrypted.ephemeralPublicKey,
    encrypted.ciphertext,
  );

  const qrString = encodeQrPayload({ encryptedKeyPackage, aliceDid });

  return {
    qrString,
    keyPackageInitKey: keyPackagePair.publicPackage.initKey,
  };
}

/**
 * Bob-side: Process scanned QR, create MLS group, add Alice, generate
 * Welcome.
 *
 * Steps:
 *   1. Decode QR and decrypt Alice's KeyPackage
 *   2. Create MLS group with Bob as founder (using the pool-provided
 *      KeyPackage pair)
 *   3. Add Alice to the group -> produces Welcome
 *   4. Derive Welcome queueId from Alice's KeyPackage initKey
 *
 * KP 池统一消费（rotation-baseline-plan.md 3.2）：Bob 的叶子密钥改为从
 * KP 池取（新鲜度受控、出生时间统一登记），不再现场生成。
 *
 * @param bobDid            - Bob's DID.
 * @param bobIdentityKeys   - Bob's dual identity keys.
 * @param qrString          - The QR string from scanning Alice's code.
 * @param bobKeyPackagePair - Bob's KeyPackage pair from the KP pool.
 * @returns MLS session, groupId, Welcome queueId + payload, and Alice's DID.
 * @throws if QR decoding or MLS group creation fails.
 */
export async function acceptInvite(
  bobDid: string,
  bobIdentityKeys: IdentityKeys,
  qrString: string,
  bobKeyPackagePair: KeyPackagePair,
): Promise<{
  mlsSession: MlsSession;
  groupId: string;
  welcomeQueueId: string;
  welcomePayload: string;
  aliceDid: string;
}> {
  const { keyPackage: aliceKeyPackage, aliceDid } = await decodeAndDecryptQr(
    qrString,
    bobIdentityKeys.encryption.privateKey,
  );

  if (aliceDid === bobDid) {
    throw new Error('Cannot accept an invite from yourself');
  }

  const impl = await getNobleMlsImpl();
  const bobCredential = createDidCredential(bobDid);
  const mlsSession = await MlsSession.createAsFounder(
    bobCredential,
    bobKeyPackagePair,
    impl,
  );

  const { welcome: welcomeBytes } = await mlsSession.addMember(aliceKeyPackage);

  const welcomeQueueId = deriveWelcomeQueueId(aliceKeyPackage.initKey);

  return {
    mlsSession,
    groupId: aliceDid,
    welcomeQueueId,
    welcomePayload: bytesToBase64url(welcomeBytes),
    aliceDid,
  };
}

/**
 * Alice-side: Process received Welcome, join the MLS group.
 *
 * Steps:
 *   1. Decode the MLS Welcome message from wire bytes
 *   2. Join the group via Welcome using Alice's KeyPackage pair
 *   3. Discover the friend's DID from group members
 *
 * @param welcomeBytes           - Raw MLS Welcome wire bytes from PDS.
 * @param aliceDid               - Alice's DID.
 * @param aliceIdentityKeys      - Alice's dual identity keys.
 * @param aliceKeyPackagePublic  - Alice's public KeyPackage (from prepareInviteQr).
 * @param aliceKeyPackagePrivate - Alice's private KeyPackage.
 * @returns MLS session and groupId (friend's DID for storage).
 * @throws if Welcome decoding or group join fails.
 */
export async function processWelcome(
  welcomeBytes: Uint8Array,
  aliceDid: string,
  aliceIdentityKeys: IdentityKeys,
  aliceKeyPackagePublic: KeyPackage,
  aliceKeyPackagePrivate: PrivateKeyPackage,
): Promise<{ mlsSession: MlsSession; groupId: string }> {
  void aliceIdentityKeys; // reserved for future credential verification

  const decoded = decodeMlsMessage(welcomeBytes, 0);
  if (!decoded) {
    throw new Error('processWelcome: failed to decode MLS message');
  }
  const [msg] = decoded;
  if (msg.wireformat !== 'mls_welcome') {
    throw new Error(
      `processWelcome: expected mls_welcome, got ${msg.wireformat}`,
    );
  }

  const welcome: Welcome = msg.welcome;
  const impl = await getNobleMlsImpl();
  const mlsSession = await MlsSession.joinViaWelcome(
    welcome,
    { publicPackage: aliceKeyPackagePublic, privatePackage: aliceKeyPackagePrivate },
    impl,
  );

  const memberDids = mlsSession.getMemberDids();
  const friendDid = memberDids.find((did) => did !== aliceDid);
  if (!friendDid) {
    throw new Error('processWelcome: no other member found in group');
  }

  return { mlsSession, groupId: friendDid };
}
