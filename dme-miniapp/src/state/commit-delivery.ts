/**
 * commit-delivery.ts - 群 commit 投递（Phase 1.0 移植，key-rotation-plan.md）
 *
 * 与 dme-client 同名实现一致：commit 包装信封用「提交前状态快照」加密，投进
 * 群自己的 queueId 空间，解除对成对 1v1 会话的投递依赖（轮换让每个成员都
 * 成为 committer，非群主成员没有与其他成员的 1v1 会话）。
 *
 * 安全红线：不得把新 state / 密钥材料经旧状态可解的信道分发——本模块只投递
 * MLS commit 公开信封，不含任何额外密钥材料。
 */

import { MlsSession } from '../crypto/mls-session';
import { getNobleMlsImpl } from '../crypto/mls-noble-kdf';
import { bytesToBase64url } from '../crypto/utils';
import type { DmeEnvelope } from '../protocol/types';

export async function deliverCommitViaGroupSpace(params: {
  preCommitStateSerialized: string;
  groupId: string;
  commitMessage: Uint8Array;
  createEnvelope: (envelope: DmeEnvelope) => Promise<unknown>;
}): Promise<void> {
  const impl = await getNobleMlsImpl();
  const snapshot = await MlsSession.deserialize(
    params.preCommitStateSerialized,
    impl,
  );

  const commitMsg = {
    type: 'group_commit' as const,
    groupId: params.groupId,
    commitPayload: bytesToBase64url(params.commitMessage),
  };
  const plaintextBytes = new TextEncoder().encode(JSON.stringify(commitMsg));
  const encResult = await snapshot.encrypt(plaintextBytes);

  const envelope: DmeEnvelope = {
    $type: 'dme.queue.envelope',
    queueId: encResult.queueId,
    payload: bytesToBase64url(encResult.ciphertext),
    createdAt: new Date().toISOString(),
    messageType: 'application',
  };
  await params.createEnvelope(envelope);
}
