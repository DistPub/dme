/**
 * atproto/session.ts - Bluesky 账号密码登录 + 会话管理（小程序版）。
 *
 * 与 dme-client 的 DmeSession 保持相同对外接口（did / handle / pdsUrlStr /
 * accessJwt / isAuthenticated / login / restore / logout），内部改为
 * 直接用 XRPC 调 com.atproto.server.*，不再依赖 @atproto/api 的
 * CredentialSession / Agent（其内部依赖 fetch / Headers / URL）。
 *
 * 额外承担 Web 端由 Agent 免费提供的两件事：
 *   1. accessJwt 过期时自动 refreshSession（见 refreshAccessToken）
 *   2. 请求头注入（Authorization / atproto-proxy / dme-server）
 */

import { PDS_URL } from '../config';
import type { DmeStorage } from '../storage/db';
import {
  HttpError,
  joinUrl,
  xrpcGetJson,
  xrpcPostEmpty,
  xrpcPostJson,
} from '../platform/http';

/** 持久化的会话数据，用于 App 重启后恢复。 */
interface StoredSession {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
  active: boolean;
  pdsUrl: string;
}

const STORAGE_KEY = 'session';

/** com.atproto.server.createSession 响应。 */
interface CreateSessionResponse {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
  active: boolean;
  didDoc?: unknown;
}

/** com.atproto.server.refreshSession 响应（与 createSession 同构）。 */
type RefreshSessionResponse = CreateSessionResponse;

/** 管理用户的 Bluesky PDS 会话。 */
export class DmeSession {
  private sessionData: StoredSession | null = null;
  private pdsUrl: string = PDS_URL;
  private storageRef: DmeStorage | null = null;
  /** 并发刷新去重：避免多个 401 同时触发 refresh。 */
  private refreshing: Promise<void> | null = null;

  /**
   * 用户输入 handle + app password 登录。
   *
   * @param identifier - Bluesky handle（如 alice.bsky.social）
   * @param password   - Bluesky app password（设置页生成，非账号密码）
   * @param storage    - 可选，传入则持久化会话
   * @param pdsUrl     - PDS 地址，默认 config.PDS_URL
   */
  async login(
    identifier: string,
    password: string,
    storage?: DmeStorage,
    pdsUrl: string = PDS_URL,
  ): Promise<void> {
    this.storageRef = storage ?? null;
    this.pdsUrl = pdsUrl.replace(/\/+$/, '');

    const res = await xrpcPostJson<CreateSessionResponse>(
      joinUrl(this.pdsUrl, 'xrpc/com.atproto.server.createSession'),
      { identifier, password },
    );

    this.sessionData = {
      did: res.did,
      handle: res.handle,
      accessJwt: res.accessJwt,
      refreshJwt: res.refreshJwt,
      active: res.active ?? true,
      pdsUrl: this.pdsUrl,
    };
    await this.persist();
  }

  /**
   * 从持久化存储恢复会话。
   *
   * @returns true 如果恢复成功
   */
  async restore(storage: DmeStorage): Promise<boolean> {
    this.storageRef = storage;
    const raw = await storage.getRaw(STORAGE_KEY);
    if (!raw) return false;

    try {
      const stored = JSON.parse(raw) as StoredSession;
      if (!stored.did || !stored.accessJwt) throw new Error('会话数据不完整');
      this.pdsUrl = (stored.pdsUrl ?? PDS_URL).replace(/\/+$/, '');
      this.sessionData = { ...stored, pdsUrl: this.pdsUrl };
      return true;
    } catch (err) {
      console.error('DmeSession: 恢复失败，清除已存会话:', err);
      await storage.deleteRaw(STORAGE_KEY);
      return false;
    }
  }

  /**
   * 用 refreshJwt 刷新 accessJwt。
   *
   * @throws 刷新失败时清除本地会话并抛出（调用方应引导重新登录）
   */
  async refreshAccessToken(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const current = this.sessionData;
    if (!current) throw new Error('DmeSession: 未登录，无法刷新');

    this.refreshing = (async () => {
      try {
        // ⚠️ refreshSession 是无输入体 procedure，必须发空 body POST。
        //    传 {} 会被 PDS 拒绝：400 InvalidRequest: A request body was provided
        //    when none was expected（2026-09-29 踩坑，改用 xrpcPostEmpty）。
        const res = await xrpcPostEmpty<RefreshSessionResponse>(
          joinUrl(this.pdsUrl, 'xrpc/com.atproto.server.refreshSession'),
          { headers: { Authorization: `Bearer ${current.refreshJwt}` } },
        );
        this.sessionData = {
          did: res.did,
          handle: res.handle,
          accessJwt: res.accessJwt,
          refreshJwt: res.refreshJwt,
          active: res.active ?? true,
          pdsUrl: this.pdsUrl,
        };
        await this.persist();
      } catch (err) {
        console.error('DmeSession: refreshSession 失败:', err);
        this.sessionData = null;
        if (this.storageRef) await this.storageRef.deleteRaw(STORAGE_KEY);
        throw err;
      } finally {
        this.refreshing = null;
      }
    })();

    return this.refreshing;
  }

  /**
   * 校验当前 accessJwt 是否仍然有效（服务端确认）。
   *
   * 为什么需要它：`restore()` 只是把本地存的 token 读回内存，**完全不碰网络** ——
   * 一个早已过期/被吊销的 token 在本地看起来完全正常，直到用户第一次发消息
   * 才以 401 形式暴露出来（体验很差：进去 App 以为登录着，一操作就失败）。
   * web 端靠 `CredentialSession.resumeSession()` 隐式做了这件事，小程序没有这层。
   *
   * 调用 `com.atproto.server.getSession`（最轻量的鉴权探测），语义：
   *   - 200            → token 有效，返回 true
   *   - 401 ExpiredToken → accessJwt 过期，**自动用 refreshJwt 换新**后再探测一次
   *   - 401 其他/刷新失败 → 会话已死，清除本地会话，返回 false
   *
   * @returns true 表示会话可用（可能已静默刷新）；false 表示需重新登录
   */
  async validateAccessToken(): Promise<boolean> {
    const current = this.sessionData;
    if (!current) return false;

    const probe = async (jwt: string): Promise<'ok' | 'expired' | 'dead'> => {
      try {
        // ⚠️ getSession 是 **query（GET）** 端点，不是 procedure（POST）。
        //    用 POST 会得到 `400 InvalidRequest: Incorrect HTTP method`。
        await xrpcGetJson<{ did: string; handle: string; active: boolean }>(
          joinUrl(this.pdsUrl, 'xrpc/com.atproto.server.getSession'),
          { headers: { Authorization: `Bearer ${jwt}` } },
        );
        return 'ok';
      } catch (err) {
        // ⚠️ 判定顺序很重要：**先用 isUnauthorized / isExpiredToken**，
        //    再做"其他错误视为网络问题"的兜底。
        //
        //    atproto PDS 对过期 token 返回的是 **400 + ExpiredToken**（不是 401）。
        //    早期实现先判断 `status === 400 → 当成参数错误直接 return 'ok'`，
        //    于是过期 token 被当成"会话有效"，既不刷新也不登出（2026-09-28 踩坑）。
        if (isExpiredToken(err)) return 'expired';
        if (isUnauthorized(err)) return 'dead';

        // 到这里才是真正的"无法判定"（断网 / 超时 / 5xx）：
        // 保留会话、不弹登出 —— 否则用户断网打开 App 就被踢了。
        console.warn('DmeSession: getSession 探测失败（非鉴权错误，保留会话）:', err);
        return 'ok';
      }
    };

    const first = await probe(current.accessJwt);
    if (first === 'ok') return true;

    if (first === 'expired') {
      try {
        await this.refreshAccessToken();
        const fresh = this.sessionData?.accessJwt;
        if (fresh && fresh !== current.accessJwt && (await probe(fresh)) === 'ok') {
          return true;
        }
      } catch (err) {
        console.error('DmeSession: token 过期且刷新失败:', err);
      }
    }

    // 走到这里：refreshJwt 也无效 / token 被吊销 → 清除本地会话（refreshAccessToken
    // 失败时内部已经清过一遍，这里是 'dead' 分支的兜底，重复清是幂等的）
    this.sessionData = null;
    if (this.storageRef) await this.storageRef.deleteRaw(STORAGE_KEY);
    return false;
  }

  /** 登出并清除持久化会话。 */
  async logout(storage?: DmeStorage): Promise<void> {
    const current = this.sessionData;
    if (current) {
      try {
        // deleteSession 同 refreshSession：无输入体 procedure，必须空 body POST。
        await xrpcPostEmpty(
          joinUrl(this.pdsUrl, 'xrpc/com.atproto.server.deleteSession'),
          { headers: { Authorization: `Bearer ${current.refreshJwt}` } },
        );
      } catch (err) {
        console.error('DmeSession: deleteSession 网络失败（忽略）:', err);
      }
    }
    this.sessionData = null;

    const target = storage ?? this.storageRef;
    if (target) await target.deleteRaw(STORAGE_KEY);
    this.storageRef = null;
  }

  /** 已认证用户的 DID。 */
  get did(): string {
    if (!this.sessionData?.did) {
      throw new Error('DmeSession: 未登录。请先调用 login / restore。');
    }
    return this.sessionData.did;
  }

  /** 已认证用户的 handle，未登录时返回空字符串。 */
  get handle(): string {
    return this.sessionData?.handle ?? '';
  }

  /** 是否已登录。 */
  get isAuthenticated(): boolean {
    return this.sessionData !== null;
  }

  /** PDS 地址。 */
  get pdsUrlStr(): string {
    return this.pdsUrl;
  }

  /** 当前 accessJwt（未登录时 null）。 */
  get accessJwt(): string | null {
    return this.sessionData?.accessJwt ?? null;
  }

  /** 当前 refreshJwt（未登录时 null）。 */
  get refreshJwt(): string | null {
    return this.sessionData?.refreshJwt ?? null;
  }

  /** 会话对象（兼容 Web 端 sessionData 语义）。 */
  get sessionDataView(): StoredSession | null {
    return this.sessionData;
  }

  /**
   * 当前绑定的存储实例（未绑定时 null）。
   *
   * 供 AppContext 在「同一个 await 链里 React state 还没更新」时兜底取用
   * —— 见 `setupIdentity` 的 storageRef 说明。
   */
  get boundStorage(): DmeStorage | null {
    return this.storageRef;
  }

  setStorage(storage: DmeStorage): void {
    this.storageRef = storage;
  }

  /** 更新 PDS 地址（设置页切换时调用）。 */
  setPdsUrl(url: string): void {
    this.pdsUrl = url.replace(/\/+$/, '');
    if (this.sessionData) this.sessionData.pdsUrl = this.pdsUrl;
  }

  private async persist(): Promise<void> {
    if (!this.storageRef || !this.sessionData) return;
    await this.storageRef.putRaw(STORAGE_KEY, JSON.stringify(this.sessionData));
  }
}

/**
 * 判断是否为「未授权 / token 无效」类错误。
 *
 * ⚠️ 关键：**不能只看 status === 401**。
 *   atproto PDS 对过期/无效 token 实际返回的是 **HTTP 400**，响应体形如
 *   `{"error":"ExpiredToken","message":"Token has expired"}` 或
 *   `{"error":"InvalidToken",...}` / `{"error":"AuthMissing",...}`。
 *   只看 401 会把这类错误漏掉，导致 token 过期后既不刷新也不登出
 *   （2026-09-28 实测踩坑：控制台报 `400 ExpiredToken` 但代码当成"请求参数错误"）。
 *
 * 因此这里同时匹配 **status** 与 **响应体里的 error 名**。
 */
export function isUnauthorized(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  if (err.status === 401) return true;
  // 400/403 也可能是 token 问题 —— 用 error 名判定
  const body = `${err.body ?? ''} ${err.message ?? ''}`;
  return /ExpiredToken|InvalidToken|AuthMissing|InvalidRequest.*token/i.test(body);
}

/**
 * 判断是否为「accessJwt 已过期」（区别于 token 被吊销/无效）。
 * 过期 → 可以用 refreshJwt 换新的；吊销 → 只能重新登录。
 */
export function isExpiredToken(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  const body = `${err.body ?? ''} ${err.message ?? ''}`;
  return /ExpiredToken|Token has expired/i.test(body);
}
