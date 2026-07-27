/**
 * atproto/pds.ts - PDS 记录操作 + server 批量查询。
 *
 * 写入：通过 Agent 调用 Bluesky PDS createRecord，记录进入用户仓库后
 *       经 Jetstream 被 dme-server 消费。
 * 查询：通过配置的 server 地址批量查询 envelopes。
 *
 * 数据流：
 *   Alice 写入 -> PDS createRecord -> Jetstream -> dme-server 存储
 *   Bob 查询 -> server batchGet -> envelopes
 */

import type { Agent } from '@atproto/api';
import type { DmeEnvelope } from '../protocol/index';
import { DME_ENVELOPE_NSID } from '../protocol/index';

interface CreateRecordResult {
  uri: string;
  cid: string;
}

interface BatchGetResponse {
  envelopes: DmeEnvelope[];
}

export class DmePds {
  private readonly agent: Agent;
  private readonly serverUrl: string;

  /**
   * @param agent     - @atproto/api Agent（来自 DmeSession）
   * @param serverUrl - DME server 地址（如 https://dme.example.com）
   */
  constructor(agent: Agent, serverUrl: string) {
    this.agent = agent;
    this.serverUrl = serverUrl;
  }

  /**
   * 写入 dme.queue.envelope 记录到 Alice 的 Bluesky PDS。
   */
  async createEnvelope(env: DmeEnvelope): Promise<CreateRecordResult> {
    const result = await this.agent.com.atproto.repo.createRecord({
      repo: this.agent.assertDid,
      collection: DME_ENVELOPE_NSID,
      record: {
        $type: DME_ENVELOPE_NSID,
        queueId: env.queueId,
        payload: env.payload,
        createdAt: env.createdAt,
        ...(env.messageType ? { messageType: env.messageType } : {}),
      },
    });

    return {
      uri: result.data.uri,
      cid: result.data.cid,
    };
  }

  /**
   * 批量查询 envelopes。
   */
  async batchGetEnvelopes(queueIds: string[]): Promise<DmeEnvelope[]> {
    const response = await fetch(`${this.serverUrl}/xrpc/dme.batch.get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queueIds }),
    });

    if (!response.ok) {
      throw new Error(`batchGetEnvelopes: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as BatchGetResponse;
    return data.envelopes;
  }
}
