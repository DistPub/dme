/**
 * commit-delivery.ts - 群 commit 投递（Phase 1.0，key-rotation-plan.md）
 *
 * 背景：群 commit 原先经「成对 1v1 会话」投递（poller.getSession(memberDid)）。
 * 该依赖对现有群管理操作结构性成立（committer 恒为 creator，creator 经邀请
 * 流程与所有成员都有 1v1），但密钥轮换（rotation）让**每个成员**都成为
 * committer——非 creator 成员没有与其他成员的 1v1 会话，会静默漏投。
 *
 * 机制：commit 包装信封改用「提交前状态快照」加密，投进**群自己的 queueId
 * 空间**。queueId = exporterSecret + senderLeafIndex + generation，收端
 * poller 本来就在逐 sender 扫这些槽位（含自叶扫描），因此：
 *  - 收端零改动（case 'group_commit' 处理路径不变）；
 *  - 同账号兄弟设备也能扫到 wrapper（它持有相同旧状态），但其无法应用
 *    commit（新熵不在任何寄给本叶的密文里）→ 正好作为「兄弟设备已轮换、
 *    请恢复备份」的检测信号（AppContext group_commit catch 分支）；
 *  - 混版本兼容：接收侧代码未变，Phase 0 渗透期的旧客户端仍按 1v1 通道
 *    收 commit，两侧投递机制在过渡期可并存。
 *
 * 安全红线（2026-10-14 翻案结论）：任何情况下不得把新 state / 密钥材料经
 * 旧状态可解的信道分发——本模块只投递 MLS commit 公开信封（path 密文本就
 * 只封给其他成员），不含任何额外的密钥材料。
 */

import { MlsSession } from '../crypto/mls-session';
import { getNobleMlsImpl } from '../crypto/mls-noble-kdf';
import { bytesToBase64url } from '../crypto/utils';
import type { DmeEnvelope } from '../protocol/types';

/**
 * 把一条已产生的 commit（调用方在产生 commit 前必须先 serialize 会话快照）
 * 包装成 group_commit 信封，用提交前状态加密后投进群的 queueId 空间。
 *
 * @param preCommitStateSerialized 产生 commit **之前**的 session.serialize()
 *   ——快照的应用链 generation 游标恰好等于各收端期望的下一个槽位。
 * @param commitMessage MLS commit 密文（收端用各自旧状态应用）。
 * @param createEnvelope 写入 PDS 的回调（通常即 pds.createEnvelope）。
 */
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
