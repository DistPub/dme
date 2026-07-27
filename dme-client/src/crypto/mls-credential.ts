/**
 * crypto/mls-credential.ts - DID-based MLS credential and authentication.
 *
 * MLS credentials carry the user's DID as the identity field. The
 * AuthenticationService validates that a credential's signature public
 * key matches the #dme_signing key in the DID document.
 *
 * The DID resolution function is injected (dependency injection) so the
 * crypto layer stays decoupled from the atproto layer.
 */

import type { AuthenticationService, Credential } from 'ts-mls';

/**
 * Create a basic MLS credential with the DID as identity.
 *
 * @param did - AT Protocol DID (did:plc:... or did:web:...).
 * @returns MLS basic credential.
 */
export function createDidCredential(did: string): Credential {
  return { credentialType: 'basic', identity: new TextEncoder().encode(did) };
}

/**
 * Extract the DID from a basic MLS credential.
 *
 * @param credential - MLS credential (must be basic type).
 * @returns DID string.
 * @throws if credential is not basic type.
 */
export function extractDid(credential: Credential): string {
  if (credential.credentialType !== 'basic') {
    throw new Error(
      'mls-credential: only basic credential supported, got ' +
        credential.credentialType,
    );
  }
  return new TextDecoder().decode(credential.identity);
}

/**
 * Create an AuthenticationService that validates credentials against DID
 * documents.
 *
 * The injected `resolveSigningKey` function fetches the Ed25519 public
 * key from a DID document's #dme_signing verification method.
 *
 * @param resolveSigningKey - Function that resolves a DID to its Ed25519 signing public key.
 * @returns AuthenticationService for MLS group operations.
 */
export function createDidAuthService(
  resolveSigningKey: (did: string) => Promise<Uint8Array | null>,
): AuthenticationService {
  return {
    validateCredential: async (
      credential: Credential,
      signaturePublicKey: Uint8Array,
    ): Promise<boolean> => {
      try {
        const did = extractDid(credential);
        const expectedKey = await resolveSigningKey(did);
        if (!expectedKey) return false;
        if (expectedKey.length !== signaturePublicKey.length) return false;
        let diff = 0;
        for (let i = 0; i < expectedKey.length; i++) {
          diff |= expectedKey[i]! ^ signaturePublicKey[i]!;
        }
        return diff === 0;
      } catch {
        return false;
      }
    },
  };
}
