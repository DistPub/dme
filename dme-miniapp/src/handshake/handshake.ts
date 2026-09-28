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
import { MlsSession } from '../crypto/mls-session';
import { createDidCredential } from '../crypto/mls-credential';
import { deriveWelcomeQueueId } from '../crypto/mls-queue-id';
import { getNobleMlsImpl } from '../crypto/mls-noble-kdf';
import {
  generateKeyPackageForUser,
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
 *   1. Generate a KeyPackage pair using Alice's Ed25519 signing key
 *   2. Encrypt the public KeyPackage with Bob's X25519 public key
 *   3. Serialize the encrypted KeyPackage to bytes
 *   4. Encode as QR string
 *
 * @param aliceDid               - Alice's DID.
 * @param aliceIdentityKeys      - Alice's dual identity keys.
 * @param bobDid                 - Bob's DID (for context, not used in encoding).
 * @param bobEncryptionPublicKey - Bob's X25519 public key from DID document.
 * @returns QR string and Alice's KeyPackage initKey (for Welcome queueId polling).
 */
export async function prepareInviteQr(
  aliceDid: string,
  aliceIdentityKeys: IdentityKeys,
  bobDid: string,
  bobEncryptionPublicKey: Uint8Array,
): Promise<{ qrString: string; keyPackageInitKey: Uint8Array }> {
  const keyPackagePair = await generateKeyPackageForUser(
    aliceDid,
    aliceIdentityKeys.signing.privateKey,
    aliceIdentityKeys.signing.publicKey,
  );

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
 *   2. Generate Bob's own KeyPackage (he is the group founder)
 *   3. Create MLS group with Bob as founder
 *   4. Add Alice to the group -> produces Welcome
 *   5. Derive Welcome queueId from Alice's KeyPackage initKey
 *
 * @param bobDid            - Bob's DID.
 * @param bobIdentityKeys   - Bob's dual identity keys.
 * @param qrString          - The QR string from scanning Alice's code.
 * @returns MLS session, groupId, Welcome queueId + payload, and Alice's DID.
 * @throws if QR decoding or MLS group creation fails.
 */
export async function acceptInvite(
  bobDid: string,
  bobIdentityKeys: IdentityKeys,
  qrString: string,
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

  const bobKeyPackagePair = await generateKeyPackageForUser(
    bobDid,
    bobIdentityKeys.signing.privateKey,
    bobIdentityKeys.signing.publicKey,
  );

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
