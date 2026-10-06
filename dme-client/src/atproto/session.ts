/**
 * atproto/session.ts - Bluesky 账号密码登录 + 会话管理。
 *
 * 直接使用 CredentialSession 让用户输入 handle + app password 登录，
 * 不走 OAuth 流程。登录后创建 Agent 供 PDS 操作使用。
 *
 * 会话数据（accessJwt / refreshJwt）存在 AsyncStorage，App 重启后可恢复。
 */

import { Agent, CredentialSession } from '@atproto/api';
import type { AtpSessionData, AtpSessionEvent } from '@atproto/api';

import { PDS_URL } from '../config';
import type { DmeStorage } from '../storage/db';
import { isEmbedContext } from '../embed/protocol';
import type { EmbedTokenPayload } from '../embed/protocol';

/**
 * CredentialSession used in embed mode.
 *
 * In embed mode the fatesky parent owns the token lifecycle, so we must never
 * refresh tokens ourselves. Overriding `refreshSession()` makes the automatic
 * refresh in `CredentialSession.fetchHandler` a no-op: its catch swallows the
 * thrown error and returns the original "ExpiredToken" response (the accessJwt
 * never changed), which is exactly the desired behavior.
 */
class EmbedCredentialSession extends CredentialSession {
  onRefreshBlocked: (() => void) | null = null;

  override async refreshSession(): Promise<void> {
    // Embed mode: fatesky owns token lifecycle. Never refresh here.
    this.onRefreshBlocked?.();
    return;
  }
}

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

/**
 * 管理用户的 Bluesky PDS 会话。
 *
 * 通过 CredentialSession 的 persistSession 回调在 token 刷新时自动
 * 持久化最新会话，App 重启后可恢复。
 */
export class DmeSession {
  private session: CredentialSession | null = null;
  private agentInstance: Agent | null = null;
  private pdsUrl: string = PDS_URL;

  /** 持久化存储引用，persistSession 回调中使用。 */
  private storageRef: DmeStorage | null = null;

  /** The most recently created CredentialSession, for embed handler forwarding. */
  private credentialSessionRef: CredentialSession | null = null;

  /** Called when embed-mode refresh is suppressed. */
  private embedRefreshBlockedHandler: (() => void) | null = null;

  constructor(private readonly embed: boolean = isEmbedContext()) {}

  /**
   * 用户输入 handle + app password 登录。
   *
   * @param identifier - Bluesky handle（如 alice.bsky.social）
   * @param password - Bluesky app password（不是账号密码，在设置页生成）
   * @param storage - 可选，传入则持久化会话
   */
  async login(
    identifier: string,
    password: string,
    storage?: DmeStorage,
    pdsUrl: string = PDS_URL,
    authFactorToken?: string,
  ): Promise<void> {
    this.storageRef = storage ?? null;
    this.pdsUrl = pdsUrl;
    const session = this.createCredentialSession();
    await session.login({ identifier, password, authFactorToken });

    this.session = session;
    this.agentInstance = new Agent(session);
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
      this.pdsUrl = stored.pdsUrl ?? PDS_URL;
      if (this.embed) {
        const credentialSession = this.createCredentialSession();
        credentialSession.session = {
          did: stored.did,
          handle: stored.handle,
          accessJwt: stored.accessJwt,
          refreshJwt: stored.refreshJwt,
          active: stored.active,
        };
        this.session = credentialSession;
        this.agentInstance = new Agent(credentialSession);
        return true;
      }
      const session = this.createCredentialSession();
      await session.resumeSession({
        did: stored.did,
        handle: stored.handle,
        accessJwt: stored.accessJwt,
        refreshJwt: stored.refreshJwt,
        active: stored.active,
      });

      this.session = session;
      this.agentInstance = new Agent(session);
      return true;
    } catch (err) {
      console.error('DmeSession: restore failed, clearing stored session:', err);
      await storage.deleteRaw(STORAGE_KEY);
      return false;
    }
  }

  /**
   * 登出并清除持久化会话。
   */
  async logout(storage?: DmeStorage): Promise<void> {
    if (this.session) {
      if (this.embed) {
        // embed: skip server deleteSession (fatesky owns shared session)
      } else {
        try {
          await this.session.logout();
        } catch (err) {
          console.error('DmeSession: logout network error (ignored):', err);
        }
      }
    }
    this.session = null;
    this.agentInstance = null;

    const target = storage ?? this.storageRef;
    if (target) {
      await target.deleteRaw(STORAGE_KEY);
    }
    this.storageRef = null;
  }

  /** 已认证用户的 DID。 */
  get did(): string {
    if (!this.session?.did) {
      throw new Error('DmeSession: not authenticated. Call login/restore first.');
    }
    return this.session.did;
  }

  /** 已认证用户的 handle，未登录时返回空字符串。 */
  get handle(): string {
    return this.session?.session?.handle ?? '';
  }

  /** @atproto/api Agent，用于 PDS 操作。 */
  get agent(): Agent {
    if (!this.agentInstance) {
      throw new Error('DmeSession: not authenticated. Call login/restore first.');
    }
    return this.agentInstance;
  }

  /** 是否已登录。 */
  get isAuthenticated(): boolean {
    return this.session !== null;
  }

  setStorage(storage: DmeStorage): void {
    this.storageRef = storage;
  }

  setEmbedRefreshBlockedHandler(fn: (() => void) | null): void {
    this.embedRefreshBlockedHandler = fn;
    if (this.credentialSessionRef instanceof EmbedCredentialSession) {
      this.credentialSessionRef.onRefreshBlocked = fn;
    }
  }

  setEmbedToken(payload: EmbedTokenPayload): void {
    if (!this.embed) return;
    const stored: StoredSession = {
      did: payload.did,
      handle: payload.handle,
      accessJwt: payload.accessJwt,
      refreshJwt: payload.refreshJwt,
      active: true,
      pdsUrl: payload.service?.trim() || this.pdsUrl,
    };
    this.pdsUrl = stored.pdsUrl;
    if (this.storageRef) {
      void this.storageRef.putRaw(STORAGE_KEY, JSON.stringify(stored));
    }
    if (this.session) {
      this.session.session = {
        did: payload.did,
        handle: payload.handle,
        accessJwt: payload.accessJwt,
        refreshJwt: payload.refreshJwt,
        active: true,
      };
    } else {
      const credentialSession = this.createCredentialSession();
      credentialSession.session = {
        did: payload.did,
        handle: payload.handle,
        accessJwt: payload.accessJwt,
        refreshJwt: payload.refreshJwt,
        active: true,
      };
      this.session = credentialSession;
      this.agentInstance = new Agent(credentialSession);
    }
  }

  get sessionData(): AtpSessionData | null {
    return this.session?.session ?? null;
  }

  /**
   * 判断服务端是否要求二步验证验证码。
   *
   * @atproto/api 的 CredentialSession 会将 PDS 返回的 XRPC 错误原样抛出，
   * 错误对象上通常带有 `error`（字符串）或 `message` 字段。开启邮箱 2FA 时
   * 服务端返回的错误名为 `AuthFactorTokenRequired`。
   */
  isAuthFactorTokenRequired(err: unknown): boolean {
    const e = err as { error?: string; message?: string } | undefined;
    const haystack = `${e?.error ?? ''} ${e?.message ?? ''}`;
    return /AuthFactorTokenRequired/i.test(haystack);
  }

  get pdsUrlStr(): string {
    return this.pdsUrl;
  }

  get accessJwt(): string | null {
    return this.session?.session?.accessJwt ?? null;
  }

  /**
   * 创建 CredentialSession 并注册 persistSession 回调。
   *
   * 回调在会话创建/刷新时自动写入存储，在过期/失败时清除存储，
   * 保证 token 刷新后持久化的总是最新 token。
   */
  private createCredentialSession(): CredentialSession {
    const persist =
      (evt: AtpSessionEvent, session: AtpSessionData | undefined) =>
        this.handlePersistSession(evt, session);

    if (this.embed) {
      const embedSession = new EmbedCredentialSession(
        new URL(this.pdsUrl),
        undefined,
        persist,
      );
      embedSession.onRefreshBlocked = this.embedRefreshBlockedHandler;
      this.credentialSessionRef = embedSession;
      return embedSession;
    }

    return new CredentialSession(new URL(this.pdsUrl), undefined, persist);
  }

  /**
   * persistSession 回调：根据事件类型同步存储。
   *
   * - create / update: 写入最新会话
   * - expired / create-failed / network-error: 清除存储
   */
  private async handlePersistSession(
    evt: AtpSessionEvent,
    session: AtpSessionData | undefined,
  ): Promise<void> {
    const storage = this.storageRef;
    if (!storage) return;

    if ((evt === 'create' || evt === 'update') && session) {
      const stored: StoredSession = {
        did: session.did,
        handle: session.handle,
        accessJwt: session.accessJwt,
        refreshJwt: session.refreshJwt,
        active: session.active,
        pdsUrl: this.pdsUrl,
      };
      await storage.putRaw(STORAGE_KEY, JSON.stringify(stored));
    } else if (evt === 'expired' || evt === 'create-failed') {
      await storage.deleteRaw(STORAGE_KEY);
    }
    // 'network-error': 保留现有存储，下次恢复时重试
  }
}
