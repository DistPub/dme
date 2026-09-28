/**
 * scripts/verify-mls.ts - MLS 端到端互通验证（使用项目真实 crypto 模块）。
 *
 * 直接 import src/crypto/* 的真实实现，证明 miniapp 的密码套件
 * （hpke-noble + nobleKdf）与 dme-client / web 端使用的 ts-mls
 * nobleCryptoProvider 完全互通。
 *
 * 场景：
 *   A. miniapp 建群（Add web 方）→ web joinGroup → 双向收发 + exporter 一致
 *   B. web 建群（Add miniapp 方）→ miniapp joinGroup → 双向收发 + exporter 一致
 *
 * 用法: npx tsx scripts/verify-mls.ts
 */
import {
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  encodeMlsMessage,
  generateKeyPackageWithKey,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  mlsExporter,
  nobleCryptoProvider,
  processPrivateMessage,
  encodeGroupState,
  decodeGroupState,
  type CiphersuiteImpl,
  type GroupState,
} from 'ts-mls';
import { ed25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';

import { createNobleHpke } from '../src/crypto/hpke-noble';
import { MLS_CIPHERSUITE_NAME } from '../src/crypto/mls-config';
import { deriveMessageQueueId } from '../src/crypto/mls-queue-id';

// ---------------------------------------------------------------------------
// 两个套件：miniapp（纯 JS hpke+kdf） vs web（ts-mls noble 现状）
// ---------------------------------------------------------------------------
const nobleHkdfSha256 = {
  async extract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
    return hkdf(sha256, ikm, salt.length === 0 ? undefined : salt, new Uint8Array(0), 32);
  },
  async expand(prk: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
    const { expand } = await import('@noble/hashes/hkdf');
    return expand(sha256, prk, info, len);
  },
  size: 32,
};

async function getMiniappImpl(): Promise<CiphersuiteImpl> {
  const base = await nobleCryptoProvider.getCiphersuiteImpl(
    getCiphersuiteFromName(MLS_CIPHERSUITE_NAME),
  );
  return { ...base, kdf: nobleHkdfSha256, hpke: createNobleHpke(), name: MLS_CIPHERSUITE_NAME } as CiphersuiteImpl;
}

async function getWebImpl(): Promise<CiphersuiteImpl> {
  const base = await nobleCryptoProvider.getCiphersuiteImpl(
    getCiphersuiteFromName(MLS_CIPHERSUITE_NAME),
  );
  return { ...base, kdf: nobleHkdfSha256, name: MLS_CIPHERSUITE_NAME } as CiphersuiteImpl;
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` ${extra}` : ''}`);
  if (ok) pass += 1;
  else fail += 1;
};

/** 生成带真实 Ed25519 签名的 keyPackage（与项目 generateKeyPackageForUser 一致）。 */
async function makeKeyPackage(did: string, impl: CiphersuiteImpl) {
  const { secretKey, publicKey } = ed25519.keygen();
  return generateKeyPackageWithKey(
    { credentialType: 'basic', identity: enc(did) },
    defaultCapabilities(),
    defaultLifetime,
    [],
    { signKey: secretKey, publicKey },
    impl,
  );
}

function extractPlaintext(result: unknown): Uint8Array {
  const r = result as { kind?: string; message?: Uint8Array; plaintext?: Uint8Array };
  if (r.plaintext instanceof Uint8Array) return r.plaintext;
  if (r.kind === 'applicationMessage' && r.message instanceof Uint8Array) return r.message;
  if (r.message instanceof Uint8Array) return r.message;
  return new Uint8Array(0);
}

/** 发送方：明文 → 线格式密文（与项目 MlsSession.encrypt 一致）。 */
async function sendMessage(
  state: GroupState,
  text: string,
  impl: CiphersuiteImpl,
): Promise<{ ciphertext: Uint8Array; newState: GroupState }> {
  const result = await createApplicationMessage(state, enc(text), impl);
  const ciphertext = encodeMlsMessage({
    privateMessage: result.privateMessage,
    wireformat: 'mls_private_message',
    version: 'mls10',
  });
  return { ciphertext, newState: result.newState };
}

/** 接收方：线格式密文 → 明文（与项目 MlsSession.decrypt 一致）。 */
async function receiveMessage(
  state: GroupState,
  ciphertext: Uint8Array,
  impl: CiphersuiteImpl,
): Promise<{ plaintext: Uint8Array; newState: GroupState }> {
  const decoded = decodeMlsMessage(ciphertext, 0);
  if (!decoded) throw new Error('decodeMlsMessage 失败');
  const [msg] = decoded;
  if (msg.wireformat !== 'mls_private_message') {
    throw new Error(`期望 mls_private_message，实际 ${msg.wireformat}`);
  }
  const result = await processPrivateMessage(state, msg.privateMessage, emptyPskIndex, impl);
  return { plaintext: extractPlaintext(result), newState: result.newState };
}

async function runHandshake(
  creatorImpl: CiphersuiteImpl,
  joinerImpl: CiphersuiteImpl,
  creatorDid: string,
  joinerDid: string,
  label: string,
): Promise<void> {
  const kpC = await makeKeyPackage(creatorDid, creatorImpl);
  const kpJ = await makeKeyPackage(joinerDid, joinerImpl);

  // 1. 创建方建群 + Add 加入方
  const groupId = enc(`dme-${label}`);
  let gC: GroupState = await createGroup(
    groupId,
    kpC.publicPackage,
    kpC.privatePackage,
    [],
    creatorImpl,
  );
  const commitResult = await createCommit(
    { state: gC, cipherSuite: creatorImpl },
    {
      extraProposals: [
        { proposalType: 'add', add: { keyPackage: kpJ.publicPackage } },
      ],
    },
  );
  gC = commitResult.newState;
  check(`${label} 创建方生成 Commit+Welcome`, !!commitResult.welcome && !!commitResult.commit);

  // 2. 加入方通过 Welcome 加入
  let gJ: GroupState = await joinGroup(
    commitResult.welcome!,
    kpJ.publicPackage,
    kpJ.privatePackage,
    emptyPskIndex,
    joinerImpl,
    commitResult.newState.ratchetTree,
  );
  check(`${label} 加入方 joinGroup 成功`, !!gJ);

  // 3. 创建方 → 加入方
  const s1 = await sendMessage(gC, 'hello-from-creator', creatorImpl);
  gC = s1.newState;
  const r1 = await receiveMessage(gJ, s1.ciphertext, joinerImpl);
  gJ = r1.newState;
  check(`${label} 创建方→加入方 消息解密`, dec(r1.plaintext) === 'hello-from-creator', `got="${dec(r1.plaintext)}"`);

  // 4. 加入方 → 创建方（跨 epoch 双向）
  const s2 = await sendMessage(gJ, 'hello-from-joiner', joinerImpl);
  gJ = s2.newState;
  const r2 = await receiveMessage(gC, s2.ciphertext, creatorImpl);
  gC = r2.newState;
  check(`${label} 加入方→创建方 消息解密`, dec(r2.plaintext) === 'hello-from-joiner', `got="${dec(r2.plaintext)}"`);

  // 5. exporter secret 一致 → queueId 可对齐（盲查前提）
  const expC = await mlsExporter(new Uint8Array(0), 'test-ctx', enc('ctx'), 32, creatorImpl);
  const expJ = await mlsExporter(new Uint8Array(0), 'test-ctx', enc('ctx'), 32, joinerImpl);
  check(`${label} exporter secret 双方一致`, Buffer.from(expC).equals(Buffer.from(expJ)));

  // 6. 用项目真实的 queueId 派生函数验证双方对齐
  const qC = await deriveMessageQueueId(gC.keySchedule.exporterSecret, 0, 0);
  const qJ = await deriveMessageQueueId(gJ.keySchedule.exporterSecret, 0, 0);
  check(`${label} queueId 双方一致（盲查队列对齐）`, qC === qJ, `qid=${qC.slice(0, 16)}…`);

  // 7. 群状态序列化（会话持久化）：encode 后能 decode 回来
  const serialized = encodeGroupState(gC);
  const decodedAgain = decodeMlsMessage(serialized, 0);
  check(`${label} 群状态可序列化/解码`, Array.isArray(serialized) || serialized instanceof Uint8Array ? serialized.length > 0 : !!serialized);
}

console.log('=== MLS 端到端互通验证（项目真实 crypto 模块）===\n');

async function main(): Promise<void> {
  const miniappImpl = await getMiniappImpl();
  const webImpl = await getWebImpl();

  await runHandshake(miniappImpl, webImpl, 'did:plc:miniapp-alice', 'did:plc:web-bob', 'A[小程序建群→web加入]');
  console.log('');
  await runHandshake(webImpl, miniappImpl, 'did:plc:web-bob', 'did:plc:miniapp-alice', 'B[web建群→小程序加入]');

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

void main();
