/**
 * atproto/did.ts - DID document reading and writing for MLS dual keys.
 *
 * Publishes both Ed25519 (#dme_signing) and X25519 (#dme_encryption)
 * public keys to the user's did:plc DID document via PLC operations.
 * Handshake partners discover each other's keys through this document
 * without a separate key server.
 *
 *   #dme_encryption (X25519)  -> KeyPackage QR encryption
 *   #dme_signing   (Ed25519)  -> MLS credential signature verification
 *
 * Reading: getRemoteEncryptionKey / getRemoteSigningKey resolve a DID
 *   and decode the corresponding verificationMethod's publicKeyMultibase
 *   through the did-key.ts encode/decode helpers.
 *
 * Writing: declareKeys signs a PLC operation through the PDS
 *   (com.atproto.identity.signPlcOperation + submitPlcOperation),
 *   adding both verificationMethods as did:key URIs.
 */

import { Agent } from '@atproto/api';
import { DidResolver, MemoryCache } from '@atproto/identity';

import { PLC_DIRECTORY_URL } from '../config';
import {
  decodeEd25519DidKey,
  decodeX25519DidKey,
  encodeEd25519DidKey,
  encodeX25519DidKey,
} from '../crypto/did-key';
import {
  DME_ENCRYPTION_KEY_ID,
  DME_SIGNING_KEY_ID,
  type IdentityKeys,
} from '../crypto/identity';

/**
 * Shared DID resolver with in-memory caching.
 *
 * Using a single instance avoids creating a new resolver on every UI render and
 * lets @atproto/identity cache DID documents across the app. did:plc DIDs are
 * routed to PLC_DIRECTORY_URL automatically.
 */
export const sharedDidResolver = new DidResolver({
  plcUrl: PLC_DIRECTORY_URL,
  didCache: new MemoryCache(),
  timeout: 20_000,
});

/** DID_KEY_PREFIX prepended to multibase values from PLC documents. */
const DID_KEY_PREFIX = 'did:key:';

/**
 * A verificationMethod entry in a DID document.
 */
interface DidVerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase?: string;
}

/**
 * Minimal DID document structure for DME's needs.
 */
interface DidDocumentLike {
  id: string;
  verificationMethod?: DidVerificationMethod[];
}

/**
 * Declare both DME keys (Ed25519 signing + X25519 encryption) in the
 * user's own did:plc DID document by signing and submitting a PLC
 * operation through the PDS.
 *
 * Flow:
 *   1. getRecommendedDidCredentials() - fetch current DID fields
 *   2. Merge both keys (as did:key URIs) into verificationMethods
 *      under the "dme_encryption" and "dme_signing" fragments
 *   3. signPlcOperation() - PDS signs the update
 *   4. submitPlcOperation() - publish the signed operation to PLC
 *
 * @param did      - The user's own DID (must match the session's DID).
 * @param keys     - Dual identity keys (Ed25519 signing + X25519 encryption).
 * @param agent    - Authenticated Agent.
 * @param plcToken - PLC operation token (emailed to the user via requestPlcSignature).
 * @throws if PLC submission fails.
 */
export async function declareKeys(
  did: string,
  keys: IdentityKeys,
  agent: Agent,
  plcToken: string,
): Promise<void> {
  const agentDid = agent.assertDid;
  if (agentDid !== did) {
    throw new Error(
      `declareKeys: agent DID ${agentDid} does not match expected ${did}`,
    );
  }

  const creds = await agent.com.atproto.identity.getRecommendedDidCredentials();

  const encFragment = DME_ENCRYPTION_KEY_ID.slice(1);
  const sigFragment = DME_SIGNING_KEY_ID.slice(1);
  const verificationMethods = {
    ...creds.data.verificationMethods,
    [encFragment]: encodeX25519DidKey(keys.encryption.publicKey),
    [sigFragment]: encodeEd25519DidKey(keys.signing.publicKey),
  };

  const signed = await agent.com.atproto.identity.signPlcOperation({
    token: plcToken,
    verificationMethods,
    rotationKeys: creds.data.rotationKeys,
    alsoKnownAs: creds.data.alsoKnownAs,
    services: creds.data.services,
  });

  await agent.com.atproto.identity.submitPlcOperation({
    operation: signed.data.operation,
  });
}

/**
 * Read a remote user's DME X25519 encryption public key from their
 * DID document's #dme_encryption verificationMethod.
 *
 * @param did - The remote user's DID (e.g., "did:plc:abc123...").
 * @returns 32-byte X25519 public key, or null if not declared.
 * @throws if DID resolution fails (network error, invalid DID, etc.).
 */
export async function getRemoteEncryptionKey(
  did: string,
): Promise<Uint8Array | null> {
  const vm = await findVerificationMethod(did, DME_ENCRYPTION_KEY_ID);
  if (!vm?.publicKeyMultibase) return null;
  return decodeX25519DidKey(`${DID_KEY_PREFIX}${vm.publicKeyMultibase}`);
}

/**
 * Read a remote user's DME Ed25519 signing public key from their
 * DID document's #dme_signing verificationMethod.
 *
 * @param did - The remote user's DID (e.g., "did:plc:abc123...").
 * @returns 32-byte Ed25519 public key, or null if not declared.
 * @throws if DID resolution fails (network error, invalid DID, etc.).
 */
export async function getRemoteSigningKey(
  did: string,
): Promise<Uint8Array | null> {
  const vm = await findVerificationMethod(did, DME_SIGNING_KEY_ID);
  if (!vm?.publicKeyMultibase) return null;
  return decodeEd25519DidKey(`${DID_KEY_PREFIX}${vm.publicKeyMultibase}`);
}

/**
 * Request a PLC operation signature token be emailed to the user.
 * Call this before declareKeys if token-based signing is needed.
 *
 * @param agent - Authenticated Agent.
 */
export async function requestPlcSignature(
  agent: Agent,
): Promise<void> {
  await agent.com.atproto.identity.requestPlcOperationSignature();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a DID document and find a verificationMethod by fragment.
 *
 * @param did      - The DID to resolve.
 * @param fragment - The verificationMethod fragment (e.g., "#dme_encryption").
 * @returns The matching DidVerificationMethod, or null if not found.
 * @throws if DID resolution fails.
 */
async function findVerificationMethod(
  did: string,
  fragment: string,
): Promise<DidVerificationMethod | null> {
  const doc = await resolveDidDocument(did);
  if (!doc?.verificationMethod) return null;
  return (
    doc.verificationMethod.find((vm) => vm.id.endsWith(fragment)) ?? null
  );
}

/**
 * Resolve a DID to its document.
 *
 * did:plc DIDs are fetched directly from the PLC directory; all others
 * fall through to @atproto/identity's DidResolver.
 *
 * @param did - The DID to resolve.
 * @returns The DID document, or null if not found.
 * @throws if PLC resolution returns a non-OK response.
 */
async function resolveDidDocument(
  did: string,
): Promise<DidDocumentLike | null> {
  return (await sharedDidResolver.resolve(did)) as DidDocumentLike | null;
}

/**
 * Resolve a DID to its PDS URL by finding the AtprotoPersonalDataServer service endpoint.
 * @param did - e.g. 'did:plc:abc123'
 * @returns PDS serviceEndpoint string
 * @throws Error if DID has no PDS service endpoint
 */
export async function resolvePdsUrl(did: string): Promise<string> {
  const doc = await sharedDidResolver.resolve(did) as { service?: Array<{ type?: string; serviceEndpoint?: string }> };
  if (!doc.service) {
    throw new Error('resolvePdsUrl: no service endpoint for ' + did);
  }
  const pds = doc.service.find(s => s.type === 'AtprotoPersonalDataServer')?.serviceEndpoint;
  if (!pds) {
    throw new Error('resolvePdsUrl: no AtprotoPersonalDataServer for ' + did);
  }
  return pds;
}

export function getDidMethod(did: string): 'plc' | 'web' | 'other' {
  if (did.startsWith('did:plc:')) return 'plc';
  if (did.startsWith('did:web:')) return 'web';
  return 'other';
}

async function fetchFullDidDocument(
  did: string,
): Promise<Record<string, unknown> | null> {
  try {
    const doc = await sharedDidResolver.resolve(did);
    return (doc as unknown as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

export interface DidWebEntry {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase: string;
}

/**
 * 为 did:web 用户生成需要更新的 DID 文档内容。
 *
 * 尝试获取当前 DID 文档并合并 DME 公钥。成功则返回完整 did.json
 * （用户直接复制替换）；失败则返回 null，调用方应显示 newEntries
 * 让用户手动添加到现有文档。
 *
 * @param did  - 用户的 did:web DID。
 * @param keys - 身份密钥对。
 * @returns didJson: 修改后的完整 did.json（或 null）；newEntries: 需要添加的两个条目。
 */
export async function generateDidWebUpdate(
  did: string,
  keys: IdentityKeys,
): Promise<{ didJson: string | null; newEntries: DidWebEntry[] }> {
  const encEntry: DidWebEntry = {
    id: `${did}${DME_ENCRYPTION_KEY_ID}`,
    type: 'Multikey',
    controller: did,
    publicKeyMultibase: encodeX25519DidKey(keys.encryption.publicKey).replace(DID_KEY_PREFIX, ''),
  };
  const sigEntry: DidWebEntry = {
    id: `${did}${DME_SIGNING_KEY_ID}`,
    type: 'Multikey',
    controller: did,
    publicKeyMultibase: encodeEd25519DidKey(keys.signing.publicKey).replace(DID_KEY_PREFIX, ''),
  };
  const newEntries = [encEntry, sigEntry];

  const doc = await fetchFullDidDocument(did);
  if (!doc) {
    return { didJson: null, newEntries };
  }

  const existingVMs = (doc.verificationMethod as DidVerificationMethod[]) ?? [];
  const filtered = existingVMs.filter(
    (vm) => !vm.id.endsWith(DME_ENCRYPTION_KEY_ID) && !vm.id.endsWith(DME_SIGNING_KEY_ID),
  );

  const updatedDoc = { ...doc, verificationMethod: [...filtered, encEntry, sigEntry] };
  return { didJson: JSON.stringify(updatedDoc, null, 2), newEntries };
}
