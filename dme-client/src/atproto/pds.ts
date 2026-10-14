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

import { DME_SERVER_URL } from '../config';
import type { Agent } from '@atproto/api';
import type { DmeEnvelope } from '../protocol/index';
import { DME_ENVELOPE_NSID } from '../protocol/index';
import { DME_BACKUP_NSID } from '../protocol/types';
import type { IdentityBackupRecord, RotationClaimRecord } from '../protocol/types';
import { DME_ROTATION_CLAIM_NSID } from '../protocol/types';

interface CreateRecordResult {
  uri: string;
  cid: string;
}

interface BatchGetResponse {
  envelopes: DmeEnvelope[];
}

export class DmePds {
  private readonly agent: Agent;
  private serverUrl: string;
  private gatewayUrl: string;
  private appViewProxy: string;

  /**
   * @param agent         - @atproto/api Agent（来自 DmeSession）
   * @param serverUrl     - DME server 地址（如 https://dme.example.com）
   * @param gatewayUrl    - DME gateway（Cloudflare Worker）地址；空字符串表示直连 server
   * @param appViewProxy  - atproto-proxy header 值，用于 PDS AppView 路由
   */
  constructor(agent: Agent, serverUrl: string, gatewayUrl: string, appViewProxy: string) {
    this.agent = agent;
    this.serverUrl = serverUrl;
    this.gatewayUrl = gatewayUrl;
    this.appViewProxy = appViewProxy;
    agent.configureProxy(appViewProxy as `did:${string}#${string}`);
  }

  setAppViewProxy(proxy: string): void {
    this.appViewProxy = proxy;
    this.agent.configureProxy(proxy as `did:${string}#${string}`);
  }

  setServerUrl(url: string): void {
    this.serverUrl = url.trim() || DME_SERVER_URL;
  }

  setGatewayUrl(url: string): void {
    this.gatewayUrl = url.trim();
  }

  getServerUrl(): string {
    return this.serverUrl;
  }

  /**
   * 客户端实际使用的 base URL（配置了网关时走网关，否则走 server）。
   */
  getBaseUrl(): string {
    return this.gatewayUrl || this.serverUrl;
  }

  /**
   * 构造 blob 拉取 URL。
   * - 网关配置时：走网关 `/xrpc/dme.file.blob` 端点（CDN 缓存 + IP 隐藏）。
   * - 网关未配置（直连 server）：发送者 PDS 没有 file.blob 端点，改走
   *   PDS 原生的 `com.atproto.sync.getBlob` 拉取已加密的 blob。
   */
  getBlobUrl(senderPdsUrl: string, did: string, cid: string): string {
    if (this.gatewayUrl) {
      return `${this.gatewayUrl}/xrpc/dme.file.blob?pds=${encodeURIComponent(senderPdsUrl)}&did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
    }
    return `${senderPdsUrl}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
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
        ...(env.blobCids ? { blobCids: env.blobCids } : {}),
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
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // 当通过网关访问时，通过 dme-server header 指定目标 server 地址
    if (this.gatewayUrl) {
      headers['dme-server'] = this.serverUrl;
    }
    const response = await fetch(`${this.getBaseUrl()}/xrpc/dme.batch.get`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ queueIds }),
    });

    if (!response.ok) {
      throw new Error(`batchGetEnvelopes: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as BatchGetResponse;
    return data.envelopes;
  }

  /**
   * 将加密的身份私钥备份写入 PDS（upsert，rkey 固定为 "self"）。
   */
  async putIdentityBackup(encryptedData: string): Promise<void> {
    await this.agent.com.atproto.repo.putRecord({
      repo: this.agent.assertDid,
      collection: DME_BACKUP_NSID,
      rkey: 'self',
      record: {
        $type: DME_BACKUP_NSID,
        encryptedData,
        createdAt: new Date().toISOString(),
      },
    });
  }

  /**
   * 从 PDS 读取身份私钥备份。不存在时返回 null。
   */
  async getIdentityBackup(): Promise<string | null> {
    try {
      const result = await this.agent.com.atproto.repo.getRecord({
        repo: this.agent.assertDid,
        collection: DME_BACKUP_NSID,
        rkey: 'self',
      });
      const record = result.data.value as IdentityBackupRecord;
      return record.encryptedData;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // 密钥轮换宣言（rotation-claim）：commit 前置检查的仲裁记录
  // ---------------------------------------------------------------------

  /**
   * 写入/覆盖轮换宣言记录（upsert，rkey 由 pre-commit exporterSecret 派生）。
   * 注意：atproto putRecord 是 last-write-wins、无原子 CAS，并发双写由
   * rotation-claim 的回读比对 nonce 兑底。
   */
  async putRotationClaim(rkey: string, payload: string): Promise<void> {
    await this.agent.com.atproto.repo.putRecord({
      repo: this.agent.assertDid,
      collection: DME_ROTATION_CLAIM_NSID,
      rkey,
      record: {
        $type: DME_ROTATION_CLAIM_NSID,
        payload,
        createdAt: new Date().toISOString(),
      },
    });
  }

  /**
   * 读取轮换宣言密文。记录不存在返回 null；网络/鉴权等未知错误抛出
   * （调用方 fail-closed：宣言不可用时不 commit）。仅「确认记录不存在」
   * 的 XRPC 错误（400/404）折叠为 null。
   */
  async getRotationClaim(rkey: string): Promise<string | null> {
    try {
      const result = await this.agent.com.atproto.repo.getRecord({
        repo: this.agent.assertDid,
        collection: DME_ROTATION_CLAIM_NSID,
        rkey,
      });
      const record = result.data.value as RotationClaimRecord;
      return record.payload ?? null;
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      if (status === 400 || status === 404) return null;
      throw err;
    }
  }

  /** 删除轮换宣言记录（尽力而为，不存在时静默忽略）。 */
  async deleteRotationClaim(rkey: string): Promise<void> {
    try {
      await this.agent.com.atproto.repo.deleteRecord({
        repo: this.agent.assertDid,
        collection: DME_ROTATION_CLAIM_NSID,
        rkey,
      });
    } catch {
      // 尽力而为：epoch 换代后槽位不再被读取，删除失败无碍
    }
  }
}
