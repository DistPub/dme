/**
 * atproto/pds.ts - PDS 记录操作 + DME server 批量查询（小程序版）。
 *
 * 写入：com.atproto.repo.createRecord / putRecord（带 atproto-proxy header）
 * 查询：POST {gateway}/xrpc/dme.batch.get（网关模式带 dme-server header）
 *
 * 与 dme-client 保持相同的构造参数与方法签名，方便上层（AppContext / poller）复用。
 */

import { DME_SERVER_URL } from '../config';
import type { DmeEnvelope } from '../protocol/index';
import { DME_ENVELOPE_NSID } from '../protocol/index';
import { DME_BACKUP_NSID } from '../protocol/types';
import type { IdentityBackupRecord, RotationClaimRecord, BackupMeta } from '../protocol/types';
import { DME_ROTATION_CLAIM_NSID } from '../protocol/types';
import { isClaimCasConflict, type ClaimSlotRecord } from '../crypto/rotation-claim';
import { joinUrl, xrpcGetJson, xrpcPostBytes, xrpcPostJson } from '../platform/http';
import { isUnauthorized, type DmeSession } from './session';
import { HttpError } from '../platform/http';

interface CreateRecordResult {
  uri: string;
  cid: string;
}

interface BatchGetResponse {
  envelopes: DmeEnvelope[];
}

/** `com.atproto.repo.uploadBlob` 返回的 blob 引用（与 web `agent.uploadBlob` 同形）。 */
export interface BlobRef {
  $type: 'blob';
  ref: { $link: string };
  mimeType: string;
  size: number;
}

/** `com.atproto.identity.resolveHandle` 的响应。 */
interface ResolveHandleResponse {
  did: string;
}

export class DmePds {
  private readonly session: DmeSession;
  private serverUrl: string;
  private gatewayUrl: string;
  private appViewProxy: string;

  /**
   * @param session      - 已登录的 DmeSession
   * @param serverUrl    - DME server 地址（如 https://dme.example.com）
   * @param gatewayUrl   - DME gateway（Cloudflare Worker）地址；空字符串表示直连 server
   * @param appViewProxy - atproto-proxy header 值，用于 PDS AppView 路由
   */
  constructor(
    session: DmeSession,
    serverUrl: string = DME_SERVER_URL,
    gatewayUrl: string = '',
    appViewProxy: string = '',
  ) {
    this.session = session;
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.gatewayUrl = gatewayUrl.replace(/\/+$/, '');
    this.appViewProxy = appViewProxy;
  }

  /** 更新 AppView proxy（设置页修改后调用）。 */
  setAppViewProxy(proxy: string): void {
    this.appViewProxy = proxy;
  }

  /** 更新 DME server 地址。 */
  setServerUrl(url: string): void {
    this.serverUrl = url.replace(/\/+$/, '');
  }

  /** 更新 gateway 地址（空字符串表示直连）。 */
  setGatewayUrl(url: string): void {
    this.gatewayUrl = url.replace(/\/+$/, '');
  }

  /** 当前 gateway 地址。 */
  getGatewayUrl(): string {
    return this.gatewayUrl;
  }

  /**
   * 批量查询的目标地址：优先走 gateway（CDN 缓存 + IP 隐藏），否则直连 server。
   */
  getBaseUrl(): string {
    return this.gatewayUrl || this.serverUrl;
  }

  /**
   * 构造 blob 拉取 URL（与 web `dme-client/src/atproto/pds.ts` 的 `getBlobUrl` 同构）。
   *
   * - 配了 gateway：走网关 `/xrpc/dme.file.blob`（CDN 缓存 + 隐藏发送方 PDS IP）。
   * - 未配 gateway（直连 server）：server 没有 file.blob 端点，改走发送方 PDS 原生的
   *   `com.atproto.sync.getBlob` 拉取已加密的 blob。
   *
   * ⚠️ 无论走哪条，域名都要加进「request 合法域名」；若想拿到**字节级下载进度**
   *    （`DownloadTask.onProgressUpdate`），还要把该域名加进「downloadFile 合法域名」。
   */
  getBlobUrl(senderPdsUrl: string, did: string, cid: string): string {
    const base = senderPdsUrl.replace(/\/+$/, '');
    if (this.gatewayUrl) {
      return (
        `${this.gatewayUrl}/xrpc/dme.file.blob` +
        `?pds=${encodeURIComponent(base)}` +
        `&did=${encodeURIComponent(did)}` +
        `&cid=${encodeURIComponent(cid)}`
      );
    }
    return `${base}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
  }

  /**
   * 执行一次带鉴权的 XRPC GET，401 时自动刷新会话并重试一次。
   */
  private async authedGet<T>(url: string): Promise<T> {
    try {
      return await xrpcGetJson<T>(url, { headers: this.authHeaders() });
    } catch (err) {
      if (isUnauthorized(err)) {
        await this.session.refreshAccessToken();
        return await xrpcGetJson<T>(url, { headers: this.authHeaders() });
      }
      throw err;
    }
  }

  /**
   * 执行一次带鉴权的 XRPC POST，401 时自动刷新会话并重试一次。
   */
  private async authedPost<T>(url: string, payload: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const run = () =>
      xrpcPostJson<T>(url, payload, {
        headers: { ...this.authHeaders(), ...(extraHeaders ?? {}) },
      });
    try {
      return await run();
    } catch (err) {
      if (isUnauthorized(err)) {
        await this.session.refreshAccessToken();
        return await run();
      }
      throw err;
    }
  }

  /** 构造鉴权 + AppView 代理请求头。 */
  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const token = this.session.accessJwt;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (this.appViewProxy) headers['atproto-proxy'] = this.appViewProxy;
    return headers;
  }

  /**
   * 经 PDS 代理调用 AppView 的 XRPC GET（等价于 web 端
   * `agent.app.bsky.actor.getProfile(...)`）。
   *
   * 请求发往 `{PDS}/xrpc/{nsid}`，并带上 `atproto-proxy` header，由 PDS
   * 转发给自建 AppView（`DEFAULT_APPVIEW_PROXY`）。
   *
   * 这样做的原因：小程序只能请求「request 合法域名」白名单内的域名，
   * 而白名单无法覆盖 bsky 官方公共端点与任意用户 handle 的 well-known
   * 路径。走 PDS 后只需 PDS 一个域名，且与 dme-client 行为完全一致。
   *
   * @param nsid  - 例如 `app.bsky.actor.getProfile`
   * @param query - 已编码的查询串（不含 `?`），可为空
   */
  async appViewGet<T>(nsid: string, query = ''): Promise<T> {
    const path = query
      ? `xrpc/${nsid}?${query}`
      : `xrpc/${nsid}`;
    return this.authedGet<T>(joinUrl(this.session.pdsUrlStr, path));
  }

  /**
   * 写入一条 dme.queue.envelope 记录（消息经 Jetstream 被 dme-server 消费）。
   */
  async createEnvelope(env: DmeEnvelope): Promise<CreateRecordResult> {
    const repo = this.session.did;
    const result = await this.authedPost<{ uri: string; cid: string }>(
      joinUrl(this.session.pdsUrlStr, 'xrpc/com.atproto.repo.createRecord'),
      {
        repo,
        collection: DME_ENVELOPE_NSID,
        record: {
          $type: DME_ENVELOPE_NSID,
          queueId: env.queueId,
          payload: env.payload,
          createdAt: env.createdAt,
          ...(env.messageType ? { messageType: env.messageType } : {}),
          ...(env.blobCids ? { blobCids: env.blobCids } : {}),
        },
      },
    );
    return { uri: result.uri, cid: result.cid };
  }

  /**
   * 批量查询 envelopes。
   *
   * 网关模式下通过 `dme-server` header 指定目标 server（无需重新部署网关）。
   */
  async batchGetEnvelopes(queueIds: string[]): Promise<DmeEnvelope[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.gatewayUrl) headers['dme-server'] = this.serverUrl;
    const data = await xrpcPostJson<BatchGetResponse>(
      joinUrl(this.getBaseUrl(), 'xrpc/dme.batch.get'),
      { queueIds },
      { headers },
    );
    return data.envelopes ?? [];
  }

  /**
   * 写入加密的身份私钥备份（upsert，rkey 固定为 "self"）。
   * meta 为外层明文元数据（设备短码 / 平台 / 会话指纹），仅供展示与
   * 覆盖提示，恢复流程不读它；缺省时不写字段（向后兼容旧记录）。
   */
  async putIdentityBackup(encryptedData: string, meta?: BackupMeta): Promise<void> {
    await this.authedPost(
      joinUrl(this.session.pdsUrlStr, 'xrpc/com.atproto.repo.putRecord'),
      {
        repo: this.session.did,
        collection: DME_BACKUP_NSID,
        rkey: 'self',
        record: {
          $type: DME_BACKUP_NSID,
          encryptedData,
          createdAt: new Date().toISOString(),
          ...(meta ? { meta } : {}),
        },
      },
    );
  }

  /**
   * 读取身份私钥备份；不存在时返回 null。
   */
  async getIdentityBackup(): Promise<string | null> {
    try {
      const result = await this.authedGet<{ value: IdentityBackupRecord }>(
        joinUrl(
          this.session.pdsUrlStr,
          'xrpc/com.atproto.repo.getRecord?repo=' +
            encodeURIComponent(this.session.did) +
            '&collection=' +
            encodeURIComponent(DME_BACKUP_NSID) +
            '&rkey=self',
        ),
      );
      return result.value?.encryptedData ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 读取完整备份记录（含外层明文元数据，供覆盖提示比对）。
   * 不存在或读取失败时返回 null——提示是尽力而为，绝不阻断备份。
   */
  async getIdentityBackupRecord(): Promise<IdentityBackupRecord | null> {
    try {
      const result = await this.authedGet<{ value: IdentityBackupRecord }>(
        joinUrl(
          this.session.pdsUrlStr,
          'xrpc/com.atproto.repo.getRecord?repo=' +
            encodeURIComponent(this.session.did) +
            '&collection=' +
            encodeURIComponent(DME_BACKUP_NSID) +
            '&rkey=self',
        ),
      );
      return result.value ?? null;
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // 密钥轮换宣言（rotation-claim）：commit 前置检查的仲裁记录
  // -----------------------------------------------------------------------

  /**
   * CAS 写入轮换宣言记录（小程序手写 XRPC 版）。
   * - expectedCid === null：槽位应为空 → createRecord 显式 rkey（原子
   *   create-if-absent，槽位已被并发写入时服务端报错）；
   * - 否则：putRecord + swapRecord=expectedCid（仅当当前记录 CID 未变才写入）。
   *
   * 返回 false = 并发落败（CAS 失败，他端先写了）——调用方必须按 taken
   * 处理、fail-closed 放弃本周期；网络等未知错误 throw（fail-closed）。
   */
  async putRotationClaim(rkey: string, payload: string, expectedCid: string | null): Promise<boolean> {
    const record = {
      $type: DME_ROTATION_CLAIM_NSID,
      payload,
      createdAt: new Date().toISOString(),
    };
    try {
      if (expectedCid === null) {
        await this.authedPost(
          joinUrl(this.session.pdsUrlStr, 'xrpc/com.atproto.repo.createRecord'),
          {
            repo: this.session.did,
            collection: DME_ROTATION_CLAIM_NSID,
            rkey,
            record,
          },
        );
      } else {
        await this.authedPost(
          joinUrl(this.session.pdsUrlStr, 'xrpc/com.atproto.repo.putRecord'),
          {
            repo: this.session.did,
            collection: DME_ROTATION_CLAIM_NSID,
            rkey,
            record,
            // atproto 原生 CAS：当前记录 CID 与 swapRecord 不一致即拒绝写入
            swapRecord: expectedCid,
          },
        );
      }
      return true;
    } catch (err) {
      if (isClaimCasConflict(err)) return false;
      throw err;
    }
  }

  /**
   * 读取轮换宣言密文 + 记录 CID（供 CAS 写入）。记录不存在返回 null；
   * 网络/鉴权等未知错误抛出（调用方 fail-closed：宣言不可用时不 commit）。
   * 仅「确认记录不存在」的 XRPC 错误（400/404）折叠为 null。
   */
  async getRotationClaim(rkey: string): Promise<ClaimSlotRecord | null> {
    try {
      const result = await this.authedGet<{
        cid?: string;
        value?: RotationClaimRecord;
      }>(
        joinUrl(
          this.session.pdsUrlStr,
          'xrpc/com.atproto.repo.getRecord?repo=' +
            encodeURIComponent(this.session.did) +
            '&collection=' +
            encodeURIComponent(DME_ROTATION_CLAIM_NSID) +
            '&rkey=' +
            encodeURIComponent(rkey),
        ),
      );
      if (!result.value?.payload) return null;
      // cid 理论上必在；缺省给空串 → CAS 比对必失败 → taken（fail-closed 安全）
      return { payload: result.value.payload, cid: result.cid ?? '' };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 400 || err.status === 404)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * CAS 删除轮换宣言记录：仅当当前记录仍是 expectedCid 对应的那条才删除，
   * 防止误删兄弟端刚落的高水位（并发写入后本端回滚删槽的场景）。
   * 尽力而为，不存在/已易主/网络失败均静默忽略。
   */
  async deleteRotationClaim(rkey: string, expectedCid: string): Promise<void> {
    try {
      await this.authedPost(
        joinUrl(this.session.pdsUrlStr, 'xrpc/com.atproto.repo.deleteRecord'),
        {
          repo: this.session.did,
          collection: DME_ROTATION_CLAIM_NSID,
          rkey,
          swapRecord: expectedCid,
        },
      );
    } catch {
      // 尽力而为：删除失败时残留记录由「同会话 epoch 未超前」判别 + TTL 兜底
    }
  }

  // -------------------------------------------------------------------------
  // 以下三个方法用于替代 web 端的 `@atproto/api` Agent ——
  // 小程序**不引入** @atproto/api（体积 + Node 依赖），只保留实际用到的能力。
  // 方法签名刻意贴近 `agent.uploadBlob` / `agent.com.atproto.repo.createRecord`
  // / `agent.com.atproto.identity.resolveHandle`，方便 invite.ts 逐行对照移植。
  // -------------------------------------------------------------------------

  /**
   * 上传二进制 blob（等价 web 的 `agent.uploadBlob(bytes, { encoding })`）。
   *
   * ⚠️ 用 `Taro.request` 的 ArrayBuffer body 直传 octet-stream。
   * **不能**用 `wx.uploadFile`：那是 multipart/form-data，PDS 不认；
   * 且我们要的是字节精确传递，不是文件表单。
   */
  async uploadBlob(bytes: Uint8Array, encoding: string): Promise<BlobRef> {
    const url = joinUrl(this.session.pdsUrlStr, 'xrpc/com.atproto.repo.uploadBlob');
    const result = await xrpcPostBytes<{ blob: BlobRef }>(url, bytes, encoding, {
      headers: this.authHeaders(),
    });
    return result.blob;
  }

  /**
   * 写入任意 collection 的 record
   * （等价 web 的 `agent.com.atproto.repo.createRecord({ repo, collection, record })`）。
   */
  async createRecord(collection: string, record: Record<string, unknown>): Promise<CreateRecordResult> {
    const result = await this.authedPost<{ uri: string; cid: string }>(
      joinUrl(this.session.pdsUrlStr, 'xrpc/com.atproto.repo.createRecord'),
      {
        repo: this.session.did,
        collection,
        record,
      },
    );
    return { uri: result.uri, cid: result.cid };
  }

  /**
   * handle → DID 解析
   * （等价 web 的 `agent.com.atproto.identity.resolveHandle({ handle })`）。
   *
   * 请求发往 PDS 的 `com.atproto.identity.resolveHandle`，由 PDS 代理解析；
   * 这样小程序只需放行 PDS 一个域名（无需 well-known 白名单）。
   */
  async resolveHandle(handle: string): Promise<string> {
    const result = await this.authedGet<ResolveHandleResponse>(
      joinUrl(
        this.session.pdsUrlStr,
        'xrpc/com.atproto.identity.resolveHandle?handle=' + encodeURIComponent(handle),
      ),
    );
    return result.did;
  }
}
