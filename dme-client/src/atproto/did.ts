/**
 * atproto/did.ts - DID document reading and writing.
 *
 * Manages the DME encryption key published in the user's did:plc DID
 * document. Handshake partners discover each other's X25519 public key
 * through this document without a separate key server.
 *
 * Reading: getRemoteEncryptionKey resolves a DID and decodes the
 *   #dme_encryption verificationMethod's publicKeyMultibase (standard
 *   X25519 multicodec multibase).
 *
 * Writing: declareEncryptionKey signs a PLC operation through the PDS
 *   (com.atproto.identity.signPlcOperation + submitPlcOperation), adding
 *   the #dme_encryption verificationMethod as a did:key URI.
 */

import type { Agent } from '@atproto/api';
import { DidResolver } from '@atproto/identity';

import { DME_ENCRYPTION_KEY_ID } from '../crypto/constants';
import { PLC_DIRECTORY_URL } from '../config';
import {
  multibaseToX25519Pub,
  x25519PubToDidKey,
} from '../crypto/did-key';

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
 * Manages reading and writing the DME encryption key in DID documents.
 */
export class DmeDidManager {
  private readonly didResolver: DidResolver;

  constructor() {
    this.didResolver = new DidResolver({});
  }

  /**
   * Read a remote user's DME encryption public key from their DID document.
   *
   * @param did - The remote user's DID (e.g., "did:plc:abc123...").
   * @returns 32-byte X25519 public key.
   * @throws if the DID cannot be resolved or has no #dme_encryption key.
   */
  async getRemoteEncryptionKey(did: string): Promise<Uint8Array> {
    const doc = await resolveDidDocument(did);

    if (!doc || !doc.verificationMethod) {
      throw new Error(`DmeDidManager: DID ${did} has no verificationMethod entries`);
    }

    const dmeKey = doc.verificationMethod.find(
      (vm) => vm.id.endsWith(DME_ENCRYPTION_KEY_ID),
    );

    if (!dmeKey) {
      throw new Error(
        `DmeDidManager: DID ${did} has no ${DME_ENCRYPTION_KEY_ID} verificationMethod`,
      );
    }

    if (!dmeKey.publicKeyMultibase) {
      throw new Error(
        `DmeDidManager: ${DME_ENCRYPTION_KEY_ID} for ${did} has no publicKeyMultibase`,
      );
    }

    return multibaseToX25519Pub(dmeKey.publicKeyMultibase);
  }

  /**
   * Declare the DME encryption public key in the user's own did:plc
   * DID document by signing and submitting a PLC operation through the
   * PDS.
   *
   * Flow:
   *   1. getRecommendedDidCredentials() - fetch current DID fields
   *      (rotationKeys, alsoKnownAs, verificationMethods, services)
   *   2. Merge the DME encryption key (as a did:key URI) into
   *      verificationMethods under the "dme_encryption" fragment
   *   3. signPlcOperation() - PDS signs the update with a rotation key
   *      using the token from requestPlcOperationSignature
   *   4. submitPlcOperation() - publish the signed operation to PLC
   *
   * @param pubKey   - The 32-byte X25519 public key to declare.
   * @param agent    - Authenticated @atproto/api Agent.
   * @param plcToken - Token from requestPlcOperationSignature (emailed
   *                   to the user). Required for signPlcOperation.
   */
  async declareEncryptionKey(
    pubKey: Uint8Array,
    agent: Agent,
    plcToken: string,
  ): Promise<void> {
    const creds = await agent.com.atproto.identity.getRecommendedDidCredentials();

    const fragment = DME_ENCRYPTION_KEY_ID.slice(1);
    const verificationMethods = {
      ...creds.data.verificationMethods,
      [fragment]: x25519PubToDidKey(pubKey),
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
   * Request a PLC operation signature token be emailed to the user.
   *
   * The user receives a token and enters it into declareEncryptionKey.
   * Call this before declareEncryptionKey.
   *
   * @param agent - Authenticated @atproto/api Agent.
   */
  static async requestPlcSignature(agent: Agent): Promise<void> {
    await agent.com.atproto.identity.requestPlcOperationSignature();
  }
}

async function resolveDidDocument(did: string): Promise<DidDocumentLike> {
  if (did.startsWith('did:plc:')) {
    const resp = await fetch(`${PLC_DIRECTORY_URL}/${encodeURIComponent(did)}`);
    if (!resp.ok) {
      throw new Error(`DmeDidManager: PLC resolution failed: ${resp.status} ${resp.statusText}`);
    }
    return (await resp.json()) as DidDocumentLike;
  }
  const resolver = new DidResolver({});
  return (await resolver.resolve(did)) as DidDocumentLike;
}
