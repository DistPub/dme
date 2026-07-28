/**
 * handshake/group-invite.ts - Group chat invitation protocol.
 *
 * All group-related messages are sent through existing 1:1 MLS sessions.
 * This module contains the logic for:
 *   1. Creating group invite requests
 *   2. Accepting/rejecting group invites
 *   3. Creating MLS group and sending Welcome to accepted members
 *   4. Broadcasting group metadata updates
 *
 * The caller (AppContext) is responsible for:
 *   - Sending MLS messages through 1:1 sessions
 *   - Storing group info and invite records
 *   - Managing MLS group sessions
 */

import type { KeyPackage, PrivateKeyPackage } from 'ts-mls';

import type {
  GroupInviteRequest,
  GroupInviteResponse,
  GroupWelcome,
  GroupMetadataUpdate,
  GroupMember,
  PendingInvite,
  GroupInfo,
} from '../protocol/group-message';
import type { MlsSession } from '../crypto/mls-session';
import type { IdentityKeys } from '../crypto/identity';
import { createDidCredential } from '../crypto/mls-credential';
import { getMlsImpl } from '../crypto/mls-config';
import {
  generateKeyPackageForUser,
  encryptKeyPackage,
  serializeEncryptedKeyPackage,
  encodeKeyPackageToWire,
  decodeKeyPackageFromWire,
} from '../crypto/keypackage';
import { base64urlToBytes, bytesToBase64url } from '../crypto/utils';

// ---------------------------------------------------------------------------
// Alice-side: Create group invite request
// ---------------------------------------------------------------------------

/**
 * Create a group invite request to send to Bob via 1:1 MLS session.
 *
 * @param params.inviteId - Unique invite ID (caller generates).
 * @param params.groupId - MLS group ID (caller generates before group creation).
 * @param params.groupName - Human-readable group name.
 * @param params.members - Current member list (just Alice at this point).
 * @returns The invite request message to send via 1:1 MLS session.
 */
export function createInviteRequest(params: {
  readonly inviteId: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly members: readonly GroupMember[];
}): GroupInviteRequest {
  return {
    type: 'group_invite_request',
    inviteId: params.inviteId,
    groupId: params.groupId,
    groupName: params.groupName,
    members: params.members,
  };
}

// ---------------------------------------------------------------------------
// Alice-side: Create invite response (accept)
// ---------------------------------------------------------------------------

/**
 * Create an invite response message for accepting an invitation.
 *
 * Bob generates a fresh KeyPackage and encrypts it with Alice's X25519
 * public key, then includes it in the response.
 *
 * @param params.inviteId - The invite ID being responded to.
 * @param params.groupId - The group ID.
 * @param params.encryptedKeyPackage - Serialized encrypted KeyPackage for Alice.
 * @returns The accept response message to send via 1:1 MLS session.
 */
export function createAcceptResponse(params: {
  readonly inviteId: string;
  readonly groupId: string;
  readonly encryptedKeyPackage: string;
}): GroupInviteResponse {
  return {
    type: 'group_invite_response',
    inviteId: params.inviteId,
    groupId: params.groupId,
    accepted: true,
    keyPackageSerialized: params.encryptedKeyPackage,
  };
}

/**
 * Create an invite response message for rejecting an invitation.
 *
 * @param params.inviteId - The invite ID being responded to.
 * @param params.groupId - The group ID.
 * @returns The reject response message to send via 1:1 MLS session.
 */
export function createRejectResponse(params: {
  readonly inviteId: string;
  readonly groupId: string;
}): GroupInviteResponse {
  return {
    type: 'group_invite_response',
    inviteId: params.inviteId,
    groupId: params.groupId,
    accepted: false,
  };
}

// ---------------------------------------------------------------------------
// Bob-side: Generate and encrypt KeyPackage for group invite
// ---------------------------------------------------------------------------

/**
 * Generate a fresh KeyPackage and encrypt it with the inviter's X25519 public key.
 *
 * @param ownDid - Bob's DID.
 * @param ownIdentityKeys - Bob's identity keys.
 * @param inviterEncryptionPublicKey - Alice's X25519 public key (from DID doc).
 * @returns Base64url-encoded serialized encrypted KeyPackage.
 */
export async function generateEncryptedKeyPackageForInvite(params: {
  readonly ownDid: string;
  readonly ownIdentityKeys: IdentityKeys;
  readonly inviterEncryptionPublicKey: Uint8Array;
}): Promise<{ encryptedKeyPackage: string; keyPackagePairSerialized: string }> {
  const keyPackagePair = await generateKeyPackageForUser(
    params.ownDid,
    params.ownIdentityKeys.signing.privateKey,
    params.ownIdentityKeys.signing.publicKey,
  );

  const encrypted = await encryptKeyPackage(
    keyPackagePair.publicPackage,
    params.inviterEncryptionPublicKey,
  );

  const serialized = serializeEncryptedKeyPackage(
    encrypted.ephemeralPublicKey,
    encrypted.ciphertext,
  );

  const pairSerialized = JSON.stringify({
    publicPackageWire: bytesToBase64url(encodeKeyPackageToWire(keyPackagePair.publicPackage)),
    privatePackage: keyPackagePair.privatePackage,
  }, (_k, v) => {
    if (v instanceof Uint8Array) return { __type: 'Uint8Array', data: bytesToBase64url(v) };
    return v;
  });

  return {
    encryptedKeyPackage: bytesToBase64url(serialized),
    keyPackagePairSerialized: pairSerialized,
  };
}

// ---------------------------------------------------------------------------
// Alice-side: Process accepted invite response
// ---------------------------------------------------------------------------

/**
 * Deserialize an encrypted KeyPackage from an accept response.
 *
 * @param keyPackageSerialized - Base64url-encoded encrypted KeyPackage.
 * @param ownEncryptionPrivateKey - Alice's X25519 private key.
 * @returns Decrypted KeyPackage.
 */
export async function deserializeAcceptedKeyPackage(params: {
  readonly keyPackageSerialized: string;
  readonly ownEncryptionPrivateKey: Uint8Array;
}): Promise<KeyPackage> {
  const {
    decryptKeyPackage,
    deserializeEncryptedKeyPackage,
  } = await import('../crypto/keypackage');

  const { ephemeralPublicKey, ciphertext } = deserializeEncryptedKeyPackage(
    base64urlToBytes(params.keyPackageSerialized),
  );

  return decryptKeyPackage(
    ephemeralPublicKey,
    ciphertext,
    params.ownEncryptionPrivateKey,
  );
}

export function deserializeOwnKeyPackagePair(
  pairSerialized: string,
): { publicPackage: KeyPackage; privatePackage: PrivateKeyPackage } {
  const pairRaw = JSON.parse(pairSerialized, (_k, v: unknown) => {
    if (v && typeof v === 'object' && (v as Record<string, unknown>).__type === 'Uint8Array') {
      return base64urlToBytes((v as { data: string }).data);
    }
    return v;
  }) as { publicPackageWire: string; privatePackage: PrivateKeyPackage };

  return {
    publicPackage: decodeKeyPackageFromWire(base64urlToBytes(pairRaw.publicPackageWire)),
    privatePackage: pairRaw.privatePackage,
  };
}

// ---------------------------------------------------------------------------
// Alice-side: Create MLS group and add members
// ---------------------------------------------------------------------------

/**
 * Create an MLS group and add all accepted members.
 *
 * @param params.ownerDid - Group creator's DID.
 * @param params.ownerIdentityKeys - Group creator's identity keys.
 * @param params.acceptedMembers - Members who accepted (with KeyPackages).
 * @returns MLS session for the new group.
 */
export async function createGroupWithMembers(params: {
  readonly groupId: string;
  readonly ownerDid: string;
  readonly ownerIdentityKeys: IdentityKeys;
  readonly acceptedMembers: readonly {
    readonly did: string;
    readonly keyPackage: KeyPackage;
  }[];
}): Promise<{
  mlsSession: MlsSession;
  welcomes: Map<string, Uint8Array>;
  commits: { commitMessage: Uint8Array; memberDids: string[] }[];
}> {
  const { MlsSession } = await import('../crypto/mls-session');

  const impl = await getMlsImpl();
  const ownerCredential = createDidCredential(params.ownerDid);
  const ownerKeyPackagePair = await generateKeyPackageForUser(
    params.ownerDid,
    params.ownerIdentityKeys.signing.privateKey,
    params.ownerIdentityKeys.signing.publicKey,
  );

  const mlsSession = await MlsSession.createAsFounder(
    ownerCredential,
    ownerKeyPackagePair,
    impl,
  );

  const welcomes = new Map<string, Uint8Array>();
  const commits: { commitMessage: Uint8Array; memberDids: string[] }[] = [];
  const addedDids: string[] = [];

  for (const member of params.acceptedMembers) {
    const { welcome, commitMessage } = await mlsSession.addMember(member.keyPackage);
    welcomes.set(member.did, welcome);

    if (addedDids.length > 0) {
      commits.push({ commitMessage, memberDids: [...addedDids] });
    }
    addedDids.push(member.did);
  }

  return { mlsSession, welcomes, commits };
}

// ---------------------------------------------------------------------------
// Alice-side: Send Welcome to accepted members
// ---------------------------------------------------------------------------

/**
 * Create a group welcome message for an accepted member.
 *
 * This should be sent via 1:1 MLS session after group creation.
 *
 * @param params.groupId - The MLS group ID.
 * @param params.groupName - Human-readable group name.
 * @param params.welcomePayload - Base64url-encoded MLS Welcome bytes.
 * @param params.members - Complete member list for the group.
 * @returns The welcome message to send via 1:1 MLS session.
 */
export function createGroupWelcome(params: {
  readonly groupId: string;
  readonly groupName: string;
  readonly welcomePayload: string;
  readonly members: readonly GroupMember[];
}): GroupWelcome {
  return {
    type: 'group_welcome',
    groupId: params.groupId,
    groupName: params.groupName,
    welcomePayload: params.welcomePayload,
    members: params.members,
  };
}

// ---------------------------------------------------------------------------
// Broadcast: Group metadata update
// ---------------------------------------------------------------------------

/**
 * Create a group metadata update message.
 *
 * This should be broadcast to all group members after member changes.
 *
 * @param params.groupId - The MLS group ID.
 * @param params.groupName - Human-readable group name.
 * @param params.members - Updated member list.
 * @returns The metadata update message to send via 1:1 MLS session to each member.
 */
export function createMetadataUpdate(params: {
  readonly groupId: string;
  readonly groupName: string;
  readonly members: readonly GroupMember[];
}): GroupMetadataUpdate {
  return {
    type: 'group_metadata_update',
    groupId: params.groupId,
    groupName: params.groupName,
    members: params.members,
  };
}
