/**
 * scripts/verify-hpke.mjs - 纯 JS HPKE 与 @hpke/core 的字节级互通自检。
 *
 * 这是本次移植最关键的一次验证：证明 src/crypto/hpke-noble.ts 的实现
 * 与 dme-client（web 端）所用的 @hpke/core 完全互操作。
 * 因为 TS 源无法直接在 node 里跑，这里内联复刻同一套算法逻辑做交叉验证。
 *
 * 用法: node scripts/verify-hpke.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes128Gcm } = require('@hpke/core');
const { x25519 } = require('@noble/curves/ed25519');
const { gcm } = require('@noble/ciphers/aes');
const { sha256 } = require('@noble/hashes/sha256');
const { hmac } = require('@noble/hashes/hmac');
const { hkdf, expand: hkdfExpand } = require('@noble/hashes/hkdf');

// ---------------------------------------------------------------------------
// 内联复刻 src/crypto/hpke-noble.ts 的算法逻辑
// ---------------------------------------------------------------------------
const HPKE_VERSION = new Uint8Array([0x48, 0x50, 0x4b, 0x45, 0x2d, 0x76, 0x31]); // "HPKE-v1"
const SUITE_ID_KEM = new Uint8Array([0x4b, 0x45, 0x4d, 0x00, 0x20]);
const SUITE_ID_HPKE = new Uint8Array([0x48, 0x50, 0x4b, 0x45, 0x00, 0x20, 0x00, 0x01, 0x00, 0x01]);
const L = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const LABEL_EAE_PRK = L('eae_prk');
const LABEL_SHARED_SECRET = L('shared_secret');
const LABEL_PSK_ID_HASH = L('psk_id_hash');
const LABEL_INFO_HASH = L('info_hash');
const LABEL_SECRET = L('secret');
const LABEL_KEY = L('key');
const LABEL_BASE_NONCE = L('base_nonce');
const LABEL_EXP = L('exp');
const LABEL_SEC = L('sec');
const LABEL_DKP_PRK = L('dkp_prk');
const LABEL_SK = L('sk');
const HASH_SIZE = 32, KEY_SIZE = 16, NONCE_SIZE = 12, N_SECRET = 32, MODE_BASE = 0;

const concat = (...ps) => {
  const o = new Uint8Array(ps.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of ps) { o.set(p, off); off += p.length; }
  return o;
};
const i2osp2 = (n) => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
const extract = (salt, ikm) => hmac(sha256, salt.length ? salt : new Uint8Array(HASH_SIZE), ikm);
const expand = (prk, info, len) => hkdfExpand(sha256, prk, info, len);
const ee = (salt, ikm, info, len) => expand(extract(salt, ikm), info, len);
const bIkm = (sid, label, ikm) => concat(HPKE_VERSION, sid, label, ikm);
const bInfo = (sid, label, info, len) => concat(i2osp2(len), HPKE_VERSION, sid, label, info);
const lxKem = (label, ikm) => extract(new Uint8Array(0), bIkm(SUITE_ID_KEM, label, ikm));
const lbKem = (prk, label, info, len) => expand(prk, bInfo(SUITE_ID_KEM, label, info, len), len);
const lxHpke = (salt, label, ikm) => extract(salt, bIkm(SUITE_ID_HPKE, label, ikm));
const lbHpke = (prk, label, info, len) => expand(prk, bInfo(SUITE_ID_HPKE, label, info, len), len);
const dh = (sk, pk) => x25519.getSharedSecret(sk, pk);
const gss = (dhr, ctx) =>
  ee(new Uint8Array(0), bIkm(SUITE_ID_KEM, LABEL_EAE_PRK, dhr), bInfo(SUITE_ID_KEM, LABEL_SHARED_SECRET, ctx, N_SECRET), N_SECRET);

function ksch(ss, info) {
  const pskIdHash = lxHpke(new Uint8Array(0), LABEL_PSK_ID_HASH, new Uint8Array(0));
  const infoHash = lxHpke(new Uint8Array(0), LABEL_INFO_HASH, info);
  const ksc = concat(new Uint8Array([MODE_BASE]), pskIdHash, infoHash);
  const ikm = bIkm(SUITE_ID_HPKE, LABEL_SECRET, new Uint8Array(0));
  return {
    exporterSecret: ee(ss, ikm, bInfo(SUITE_ID_HPKE, LABEL_EXP, ksc, HASH_SIZE), HASH_SIZE),
    key: ee(ss, ikm, bInfo(SUITE_ID_HPKE, LABEL_KEY, ksc, KEY_SIZE), KEY_SIZE),
    baseNonce: ee(ss, ikm, bInfo(SUITE_ID_HPKE, LABEL_BASE_NONCE, ksc, NONCE_SIZE), NONCE_SIZE),
  };
}
function mineSeal(pk, pt, info, aad) {
  const sk = crypto.getRandomValues(new Uint8Array(32));
  const ephPk = x25519.getPublicKey(sk);
  const ss = gss(dh(sk, pk), concat(ephPk, pk));
  const ks = ksch(ss, info);
  return { ct: gcm(ks.key, ks.baseNonce, aad ?? new Uint8Array(0)).encrypt(pt), enc: ephPk };
}
function mineOpen(sk, enc, ct, info, aad) {
  const pk = x25519.getPublicKey(sk);
  const ss = gss(dh(sk, enc), concat(enc, pk));
  const ks = ksch(ss, info);
  return gcm(ks.key, ks.baseNonce, aad ?? new Uint8Array(0)).decrypt(ct);
}
function mineExport(pk, expCtx, len, info) {
  const sk = crypto.getRandomValues(new Uint8Array(32));
  const ephPk = x25519.getPublicKey(sk);
  const ss = gss(dh(sk, pk), concat(ephPk, pk));
  const ks = ksch(ss, info);
  return { enc: ephPk, secret: lbHpke(ks.exporterSecret, LABEL_SEC, expCtx, len) };
}
function mineImport(sk, expCtx, enc, len, info) {
  const pk = x25519.getPublicKey(sk);
  const ss = gss(dh(sk, enc), concat(enc, pk));
  const ks = ksch(ss, info);
  return lbHpke(ks.exporterSecret, LABEL_SEC, expCtx, len);
}

// ---------------------------------------------------------------------------
// 参考实现（dme-client / web 端实际使用的那套）
// ---------------------------------------------------------------------------
const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });

const skR = crypto.getRandomValues(new Uint8Array(32));
const pkR = x25519.getPublicKey(skR);
const refPriv = await suite.kem.importKey('raw', skR, false);
const refPub = await suite.kem.importKey('raw', pkR, true);

const info = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const aad = new Uint8Array([9, 9, 9]);
const msg = new TextEncoder().encode('dme miniapp hpke interop test');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✅' : '❌'} ${name} ${extra}`); ok ? pass++ : fail++; };
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));

// A. 我方 seal → 参考 open
{
  const { ct, enc } = mineSeal(pkR, msg, info, aad);
  const ctx = await suite.createRecipientContext({ recipientKey: refPriv, enc, info });
  check('我方 seal → @hpke open', eq(new Uint8Array(await ctx.open(ct, aad)), msg));
}
// B. 参考 seal → 我方 open
{
  const ctx = await suite.createSenderContext({ recipientPublicKey: refPub, info });
  const ct = new Uint8Array(await ctx.seal(msg, aad));
  check('@hpke seal → 我方 open', eq(mineOpen(skR, new Uint8Array(ctx.enc), ct, info, aad), msg));
}
// C. exportSecret 一致（MLS exporter secret → queueId 派生依赖）
{
  const expCtx = new Uint8Array([7, 7, 7, 7]);
  const mine = mineExport(pkR, expCtx, 32, info);
  const ctx = await suite.createRecipientContext({ recipientKey: refPriv, enc: mine.enc, info });
  const refSecret = new Uint8Array(await ctx.export(expCtx, 32));
  check('exportSecret 与 @hpke 一致', eq(mine.secret, refSecret), `(${Buffer.from(mine.secret).toString('hex').slice(0, 16)}…)`);
}
// D. importSecret 一致
{
  const expCtx = new Uint8Array([5, 5, 5]);
  const ctx = await suite.createSenderContext({ recipientPublicKey: refPub, info });
  const refSecret = new Uint8Array(await ctx.export(expCtx, 32));
  check('importSecret 与 @hpke 一致', eq(mineImport(skR, expCtx, new Uint8Array(ctx.enc), 32, info), refSecret));
}
// E. deriveKeyPair 一致
{
  const ikm = new Uint8Array(32).fill(42);
  const refKp = await suite.kem.deriveKeyPair(ikm);
  const refSk = new Uint8Array(await suite.kem.serializePrivateKey(refKp.privateKey));
  const refPk = new Uint8Array(await suite.kem.serializePublicKey(refKp.publicKey));
  const sk = lbKem(lxKem(LABEL_DKP_PRK, ikm), LABEL_SK, new Uint8Array(0), 32);
  check('deriveKeyPair 私钥一致', eq(sk, refSk));
  check('deriveKeyPair 公钥一致', eq(x25519.getPublicKey(sk), refPk));
}
// F. 空 info / 空 aad
{
  const { ct, enc } = mineSeal(pkR, msg, new Uint8Array(0));
  const ctx = await suite.createRecipientContext({ recipientKey: refPriv, enc, info: new Uint8Array(0) });
  check('空 info/aad 互操作', eq(new Uint8Array(await ctx.open(ct)), msg));
}
// G. 大消息（多块 GCM）
{
  const big = crypto.getRandomValues(new Uint8Array(5000));
  const { ct, enc } = mineSeal(pkR, big, info, aad);
  const ctx = await suite.createRecipientContext({ recipientKey: refPriv, enc, info });
  check('5000 字节消息互操作', eq(new Uint8Array(await ctx.open(ct, aad)), big));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
