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
import { DidResolver } from '@atproto/identity';

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
  if (did.startsWith('did:plc:')) {
    const resp = await fetch(
      `${PLC_DIRECTORY_URL}/${encodeURIComponent(did)}`,
    );
    if (!resp.ok) {
      throw new Error(
        `did: PLC resolution failed: ${resp.status} ${resp.statusText}`,
      );
    }
    return (await resp.json()) as DidDocumentLike;
  }
  const resolver = new DidResolver({});
  return (await resolver.resolve(did)) as DidDocumentLike | null;
}
