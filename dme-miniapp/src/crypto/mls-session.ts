/**
 * crypto/mls-session.ts - MLS group session management.
 *
 * Replaces DoubleRatchet as the core encryption abstraction. An MlsSession
 * wraps a ts-mls ClientState, providing encrypt/decrypt, member
 * add/remove/update, and serialization for AsyncStorage persistence.
 *
 * QueueID derivation uses the MLS exporter secret + sender leaf index +
 * generation, preserving the blind-lookup polling model.
 */

import {
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeGroupState,
  decodeMlsMessage,
  defaultAuthenticationService,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  emptyPskIndex,
  encodeGroupState,
  encodeMlsMessage,
  joinGroup,
  processPrivateMessage,
  zeroOutUint8Array,
  type CiphersuiteImpl,
  type ClientConfig,
  type ClientState,
  type Credential,
  type KeyPackage,
  type PrivateKeyPackage,
  type Proposal,
  type RatchetTree,
  type Welcome,
} from 'ts-mls';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';

import { MLS_GROUP_ID_PREFIX } from './mls-config';
import { deriveMessageQueueId } from './mls-queue-id';
import { extractDid } from './mls-credential';
import { bytesToBase64url, base64urlToBytes } from './utils';

/** A public + private KeyPackage pair. */
interface KeyPackagePair {
  publicPackage: KeyPackage;
  privatePackage: PrivateKeyPackage;
}

function createDefaultClientConfig(): ClientConfig {
  return {
    keyRetentionConfig: defaultKeyRetentionConfig,
    lifetimeConfig: defaultLifetimeConfig,
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
    paddingConfig: defaultPaddingConfig,
    authService: defaultAuthenticationService,
  };
}

export class MlsSession {
  private state: ClientState;
  private impl: CiphersuiteImpl;
  private readonly senderLeafIndex: number;

  private constructor(state: ClientState, impl: CiphersuiteImpl) {
    this.state = state;
    this.impl = impl;
    this.senderLeafIndex = state.privatePath.leafIndex;
  }

  static async createAsFounder(
    founderCredential: Credential,
    founderKeyPackage: KeyPackagePair,
    impl: CiphersuiteImpl,
  ): Promise<MlsSession> {
    const randomBytes = crypto.getRandomValues(new Uint8Array(16));
    const groupId = concatBytes(utf8ToBytes(MLS_GROUP_ID_PREFIX), randomBytes);
    const state = await createGroup(
      groupId,
      founderKeyPackage.publicPackage,
      founderKeyPackage.privatePackage,
      [],
      impl,
    );
    return new MlsSession(state, impl);
  }

  static async joinViaWelcome(
    welcome: Welcome,
    ownKeyPackage: KeyPackagePair,
    impl: CiphersuiteImpl,
    ratchetTree?: RatchetTree,
  ): Promise<MlsSession> {
    const state = await joinGroup(
      welcome,
      ownKeyPackage.publicPackage,
      ownKeyPackage.privatePackage,
      emptyPskIndex,
      impl,
      ratchetTree,
    );
    return new MlsSession(state, impl);
  }

  async addMember(
    newMemberKeyPackage: KeyPackage,
  ): Promise<{ welcome: Uint8Array; commitMessage: Uint8Array }> {
    const addProposal: Proposal = {
      proposalType: 'add',
      add: { keyPackage: newMemberKeyPackage },
    };
    const result = await createCommit(
      { state: this.state, cipherSuite: this.impl },
      { extraProposals: [addProposal], ratchetTreeExtension: true },
    );
    this.state = result.newState;
    result.consumed.forEach(zeroOutUint8Array);
    if (!result.welcome) {
      throw new Error('mls-session: addMember did not produce a Welcome');
    }
    const welcome = encodeMlsMessage({
      welcome: result.welcome,
      wireformat: 'mls_welcome',
      version: 'mls10',
    });
    const commitMessage = encodeMlsMessage(result.commit);
    return { welcome, commitMessage };
  }

  async removeMember(
    leafIndex: number,
  ): Promise<{ commitMessage: Uint8Array }> {
    const removeProposal: Proposal = {
      proposalType: 'remove',
      remove: { removed: leafIndex },
    };
    const result = await createCommit(
      { state: this.state, cipherSuite: this.impl },
      { extraProposals: [removeProposal] },
    );
    this.state = result.newState;
    result.consumed.forEach(zeroOutUint8Array);
    return { commitMessage: encodeMlsMessage(result.commit) };
  }

  async updateOwnLeaf(): Promise<{ commitMessage: Uint8Array }> {
    const result = await createCommit(
      { state: this.state, cipherSuite: this.impl },
      {},
    );
    this.state = result.newState;
    result.consumed.forEach(zeroOutUint8Array);
    return { commitMessage: encodeMlsMessage(result.commit) };
  }

  async encrypt(
    plaintext: Uint8Array,
  ): Promise<{ ciphertext: Uint8Array; queueId: string; generation: number }> {
    const generation = this.getExpectedGeneration(this.senderLeafIndex);
    console.log('MlsSession.encrypt: senderLeafIndex', this.senderLeafIndex, 'generation', generation);
    const result = await createApplicationMessage(
      this.state,
      plaintext,
      this.impl,
    );
    this.state = result.newState;
    result.consumed.forEach(zeroOutUint8Array);
    const queueId = await deriveMessageQueueId(
      this.state.keySchedule.exporterSecret,
      this.senderLeafIndex,
      generation,
    );
    console.log('MlsSession.encrypt: queueId', queueId, 'members', this.getMemberDids());
    const ciphertext = encodeMlsMessage({
      privateMessage: result.privateMessage,
      wireformat: 'mls_private_message',
      version: 'mls10',
    });
    return { ciphertext, queueId, generation };
  }

  async decrypt(
    ciphertext: Uint8Array,
  ): Promise<{ plaintext: Uint8Array | null; isCommit: boolean }> {
    const decoded = decodeMlsMessage(ciphertext, 0);
    if (!decoded) {
      throw new Error('mls-session: failed to decode MLS message');
    }
    const [msg] = decoded;
    if (msg.wireformat !== 'mls_private_message') {
      throw new Error(
        `mls-session: expected mls_private_message, got ${msg.wireformat}`,
      );
    }

    const gensBefore = this.state.secretTree.map((n: { application: { generation: number } }) => n?.application?.generation ?? -1);
    console.log('MlsSession.decrypt: gensBefore', gensBefore);

    const result = await processPrivateMessage(
      this.state,
      msg.privateMessage,
      emptyPskIndex,
      this.impl,
    );
    this.state = result.newState;
    result.consumed.forEach(zeroOutUint8Array);

    const gensAfter = this.state.secretTree.map((n: { application: { generation: number } }) => n?.application?.generation ?? -1);
    console.log('MlsSession.decrypt: gensAfter', gensAfter, 'kind', result.kind);

    if (result.kind === 'applicationMessage') {
      return { plaintext: result.message, isCommit: false };
    }
    return { plaintext: null, isCommit: true };
  }

  getExporterSecret(): Uint8Array {
    return this.state.keySchedule.exporterSecret;
  }

  getSenderLeafIndex(): number {
    return this.senderLeafIndex;
  }

  getExpectedGeneration(senderLeafIndex: number): number {
    const treePos = senderLeafIndex * 2;
    const node = this.state.secretTree[treePos];
    if (!node) return 0;
    return node.application.generation;
  }

  getMemberDids(): string[] {
    const dids: string[] = [];
    for (let i = 0; i < this.state.ratchetTree.length; i += 2) {
      const node = this.state.ratchetTree[i];
      if (node && node.nodeType === 'leaf') {
        dids.push(extractDid(node.leaf.credential));
      }
    }
    return dids;
  }

  serialize(): string {
    const genBefore = this.getExpectedGeneration(0);
    const encoded = bytesToBase64url(encodeGroupState(this.state));
    const genAfter = this.getExpectedGeneration(0);
    if (genBefore !== genAfter) {
      console.log('MlsSession.serialize: gen CHANGED from', genBefore, 'to', genAfter);
    }
    return encoded;
  }

  static async deserialize(
    serialized: string,
    impl: CiphersuiteImpl,
  ): Promise<MlsSession> {
    const bytes = base64urlToBytes(serialized);
    const result = decodeGroupState(bytes, 0);
    if (!result) {
      throw new Error('mls-session: failed to decode group state');
    }
    const [groupState] = result;
    const clientState: ClientState = {
      ...groupState,
      clientConfig: createDefaultClientConfig(),
    };
    return new MlsSession(clientState, impl);
  }
}
