/**
 * pages/chat-list/index.tsx - 主页（会话列表）。
 *
 * 对照 dme-client/src/ui/ChatListScreen.tsx 原样复刻：
 *   - 顶栏: [标题] ......... [+ 群聊] [+ 好友] [头像+昵称/handle ▾]
 *   - 头像菜单: 扫码 / 设置 / 屏蔽列表 / 退出登录(红字)
 *   - 列表头三个区块: 收到群邀请 / 已发群邀请进度 / 待处理握手
 *   - 会话行: PDS 头像 + 群聊前缀 + 昵称 + @handle + 相对时间 + 预览 + 未读角标(99+)
 *   - 行左滑 → 删除好友（小程序替代 web 的右滑，touch 事件实现）
 *   - 退出登录: Modal 两次备份密码 → backupIdentity → logout
 *   - 转发模式: 从 ChatView 带 forwardText（文本）或 forwardPath/forwardName/
 *     forwardMime/forwardSize（文件消息长按 → 转发）进来，点击行 = 直接发送
 *
 * 🔴 嵌入模式（embed）相关逻辑一律不移植（见 IMPROVEMENT-PLAN.md §七）：
 *    web 原代码中头像菜单的「退出登录」被 `{!isEmbedContext() && ...}` 包裹，
 *    小程序无 iframe 宿主，这里**无条件渲染**该菜单项。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, Button, Input, Image } from '@tarojs/components';
import Taro, { useDidShow, useRouter } from '@tarojs/taro';

import { useApp } from '../../state/AppContext';
import { useI18n } from '../../i18n/I18nContext';
import type { PendingWelcome, StoredMessage } from '../../storage/db';
import { getProfileCached, getProfilesCached, resolveHandleCached } from '../../atproto/profile-cache';
import { useWebTitle } from '../../utils/web-title';
import { getScreenSize, touchOf } from '../../utils/screen';
import { LogoSpinner } from '../../components/LogoSpinner';
import './index.scss';

interface ConversationRow {
  conversationId: string;
  displayName: string;
  handle: string;
  avatarUrl: string | null;
  lastMessage: StoredMessage | null;
  isGroup: boolean;
  unreadCount: number;
}

interface ProfileEntry {
  handle: string;
  displayName: string;
  avatar: string | null;
}

/** 左滑露出的删除按钮宽度（真实 px；= scss 里 144px 编译成 rpx 的换算值）。 */
const SWIPE_W = Math.round((getScreenSize().width * 144) / 750);

/** 相对时间（对齐 web 的 chatlist.time* 文案）。 */
function formatTimeAgo(
  iso: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t('chatlist.timeJustNow');
  if (min < 60) return t('chatlist.timeMinutes', { n: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t('chatlist.timeHours', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('chatlist.timeDays', { n: days });
  const d = new Date(then);
  return t('chatlist.timeDate', { M: d.getMonth() + 1, D: d.getDate() });
}

export default function ChatListPage(): React.JSX.Element {
  const { t } = useI18n();
  const router = useRouter();
  const forwardText = router.params.forwardText
    ? decodeURIComponent(router.params.forwardText)
    : undefined;
  // 文件转发（chat-view 长按文件消息 → 转发）：路径等元信息走 URL 参数
  const forwardPath = router.params.forwardPath
    ? decodeURIComponent(router.params.forwardPath)
    : undefined;
  const forwardName = router.params.forwardName
    ? decodeURIComponent(router.params.forwardName)
    : '';
  const forwardMime = router.params.forwardMime
    ? decodeURIComponent(router.params.forwardMime)
    : 'application/octet-stream';
  const forwardSize = Number(router.params.forwardSize ?? '0') || 0;
  /** 是否处于转发模式（文本或文件）。 */
  const forwarding = !!(forwardText || forwardPath);

  const {
    session,
    storage,
    pds,
    groups,
    groupInfos,
    chatListVersion,
    blockList,
    receivedGroupInvites,
    pendingInvites,
    pendingWelcomes,
    pollNow,
    poller,
    restoreSession,
    ensureValidSession,
    deleteFriend,
    respondToGroupInvite,
    createGroupFromPendingInvites,
    cancelGroupInvite,
    addAcceptedMembersToGroup,
    deletePendingWelcome,
    markConversationAsRead,
    sendMessage,
    sendFileMessage,
    backupIdentity,
    logout,
  } = useApp();

  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);

  // ---- 左滑删除（对应 web 的右滑删除好友手势） ----------------------------
  /** 当前左滑展开的行及偏移（真实 px，负值 = 向左露出删除按钮）。 */
  const [swipe, setSwipe] = useState<{ id: string; offset: number } | null>(null);
  /** 手指拖动中的行 id（拖动期间不加 transition，松手回弹才有动画）。 */
  const [swipeTouchingId, setSwipeTouchingId] = useState('');
  const swipeTouch = useRef<{ x: number; y: number; base: number; horizontal: boolean | null } | null>(null);
  /** 刚完成滑动后吞掉随之而来的 tap，防止误触进入会话。 */
  const swipeGuardRef = useRef(false);

  const [myAvatarUrl, setMyAvatarUrl] = useState<string | null>(null);
  const [myAvatarError, setMyAvatarError] = useState(false);
  const [myDisplayName, setMyDisplayName] = useState('');
  const [myHandle, setMyHandle] = useState('');

  const [inviterHandles, setInviterHandles] = useState<Record<string, string>>({});
  const [welcomeHandles, setWelcomeHandles] = useState<Record<string, string>>({});

  const [logoutModalVisible, setLogoutModalVisible] = useState(false);
  const [backupPwd, setBackupPwd] = useState('');
  const [backupPwdConfirm, setBackupPwdConfirm] = useState('');
  const [logoutStatus, setLogoutStatus] = useState<'idle' | 'backing_up' | 'error'>('idle');
  const [logoutError, setLogoutError] = useState<string | null>(null);
  /** 退出-备份流程重入闸门：防 showLoading 让步窗口内的重复点击。 */
  const logoutBusyRef = useRef(false);

  const handleCacheRef = useRef<Record<string, string>>({});
  const profileCacheRef = useRef<Record<string, ProfileEntry>>({});

  useWebTitle(forwarding ? t('chatlist.selectForwardTarget') : t('chatlist.title'));

  // ---- 未登录则回登录页 --------------------------------------------------
  // ⚠️ 注意：内存里已有 session **不代表 token 还有效**（restore 只读本地）。
  //    所以这里不能直接 setReady(true) 短路，必须让上面的 useDidShow 做服务端校验。
  //    这里只负责"内存里连 session 都没有"的情况：尝试 restore，失败就回登录页。
  useEffect(() => {
    if (session) {
      setReady(true);
      return;
    }
    (async () => {
      const restored = await restoreSession();
      if (!restored) {
        await Taro.reLaunch({ url: '/pages/login/index' });
      } else {
        // ⚠️ 与 web 端一致：恢复成功后先进 Setup 页校验
        //    「本地密钥 vs DID 文档已声明公钥」的一致性，再由它放行回本页。
        await Taro.reLaunch({ url: '/pages/setup/index' });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // ---- DID → handle（带 ref 缓存） --------------------------------------
  const resolveHandle = useCallback(async (did: string): Promise<string> => {
    const cached = handleCacheRef.current[did];
    if (cached) return cached;
    try {
      const handle = await resolveHandleCached(did);
      if (handle && handle !== did) {
        handleCacheRef.current[did] = handle;
        return handle;
      }
    } catch (err) {
      console.warn('chat-list: resolveHandle 失败', did, err);
    }
    handleCacheRef.current[did] = did;
    return did;
  }, []);

  const resolveProfiles = useCallback(
    async (dids: string[]): Promise<Record<string, ProfileEntry>> => {
      const missing = [...new Set(dids.filter((did) => !profileCacheRef.current[did]))];
      if (missing.length > 0 && pds) {
        try {
          const profiles = await getProfilesCached(pds, missing);
          for (const did of missing) {
            const profile = profiles[did];
            if (!profile) continue;
            profileCacheRef.current[did] = {
              handle: profile.handle || did,
              displayName: profile.displayName ?? '',
              avatar: profile.avatar ?? null,
            };
          }
        } catch (err) {
          console.warn('chat-list: getProfilesCached 失败', err);
        }
      }
      // 兜底：批量资料拿不到的，逐个 resolveHandle
      const stillMissing = missing.filter((did) => !profileCacheRef.current[did]);
      if (stillMissing.length > 0) {
        const handles = await Promise.all(stillMissing.map((did) => resolveHandle(did)));
        stillMissing.forEach((did, i) => {
          profileCacheRef.current[did] = {
            handle: handles[i] ?? did,
            displayName: '',
            avatar: null,
          };
        });
      }
      const result: Record<string, ProfileEntry> = {};
      for (const did of dids) {
        if (profileCacheRef.current[did]) result[did] = profileCacheRef.current[did];
      }
      return result;
    },
    [pds, resolveHandle],
  );

  // ---- 自己的资料（顶栏头像 + 昵称） ------------------------------------
  useEffect(() => {
    if (!session || !pds) return;
    let cancelled = false;
    (async () => {
      try {
        const profile = await getProfileCached(pds, session.did);
        if (cancelled || !profile) return;
        if (profile.avatar) setMyAvatarUrl(profile.avatar);
        setMyDisplayName(profile.displayName ?? '');
        setMyHandle(profile.handle ?? '');
      } catch (err) {
        console.warn('chat-list: 拉取本人资料失败', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, pds]);

  // ---- 组装会话行 --------------------------------------------------------
  const loadConversations = useCallback(async (): Promise<void> => {
    if (!storage || !session) {
      setRows([]);
      setLoading(false);
      return;
    }
    const myDid = session.did;
    const blockedSet = new Set(blockList);

    const groupIdList = await storage.listGroups();
    const infos = await storage.listGroupInfos();
    const infoMap = new Map(infos.map((g) => [g.groupId, g]));

    const messagesByGroup = await Promise.all(
      groupIdList.map(async (gid) => ({ gid, messages: await storage.getMessages(gid) })),
    );
    const messagesMap = new Map(messagesByGroup.map((x) => [x.gid, x.messages]));

    const friendDids = groupIdList.filter((gid) => !infoMap.has(gid));

    const built: ConversationRow[] = groupIdList.map((gid) => {
      const messages = messagesMap.get(gid) ?? [];
      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
      // 与 web 逐字一致的未读规则（同 embed/unread.ts 的 computeTotalUnread）
      const unreadCount = messages.filter(
        (m) => m.fromDid !== myDid && !m.readAt && !blockedSet.has(m.fromDid),
      ).length;

      const info = infoMap.get(gid);
      if (info) {
        return {
          conversationId: gid,
          displayName: info.groupName,
          handle: handleCacheRef.current[info.creatorDid] ?? '',
          avatarUrl: null,
          lastMessage,
          isGroup: true,
          unreadCount,
        };
      }
      const cached = profileCacheRef.current[gid];
      return {
        conversationId: gid,
        displayName: cached?.displayName || cached?.handle || handleCacheRef.current[gid] || gid,
        handle: cached?.handle ?? handleCacheRef.current[gid] ?? gid,
        avatarUrl: cached?.avatar ?? null,
        lastMessage,
        isGroup: false,
        unreadCount,
      };
    });

    built.sort((a, b) => {
      const ta = a.lastMessage?.createdAt;
      const tb = b.lastMessage?.createdAt;
      if (!ta && !tb) return 0;
      if (!ta) return 1;
      if (!tb) return -1;
      return tb.localeCompare(ta);
    });

    setRows(built);
    setLoading(false);

    const creatorDids = infos.map((g) => g.creatorDid);
    const needsRefresh =
      friendDids.some((did) => !profileCacheRef.current[did]) ||
      creatorDids.some((did) => !handleCacheRef.current[did]);
    if (!needsRefresh) return;

    void (async () => {
      const refreshedProfiles = friendDids.length > 0 ? await resolveProfiles(friendDids) : {};
      const creatorHandles = creatorDids.length > 0
        ? await Promise.all(creatorDids.map((did) => resolveHandle(did)))
        : [];
      const creatorMap = new Map(creatorDids.map((did, i) => [did, creatorHandles[i] ?? '']));

      setRows((prev) =>
        prev.map((row) => {
          if (row.isGroup) {
            const info = infoMap.get(row.conversationId);
            if (!info) return row;
            const handle = creatorMap.get(info.creatorDid) ?? row.handle;
            return handle !== row.handle ? { ...row, handle } : row;
          }
          const profile = refreshedProfiles[row.conversationId];
          if (!profile) return row;
          const displayName = profile.displayName || profile.handle || row.displayName;
          const avatarUrl = profile.avatar ?? row.avatarUrl;
          const handle = profile.handle ?? row.handle;
          if (
            displayName === row.displayName &&
            avatarUrl === row.avatarUrl &&
            handle === row.handle
          ) {
            return row;
          }
          return { ...row, displayName, avatarUrl, handle };
        }),
      );
    })();
  }, [storage, session, blockList, resolveProfiles, resolveHandle]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations, groups, groupInfos, chatListVersion]);

  // ---- 邀请方 handle 解析 ------------------------------------------------
  useEffect(() => {
    const dids = [
      ...new Set(
        receivedGroupInvites
          .filter((i) => i.status === 'pending' && !inviterHandles[i.inviterDid])
          .map((i) => i.inviterDid),
      ),
    ];
    if (dids.length === 0) return;
    let cancelled = false;
    (async () => {
      const pairs = await Promise.all(dids.map(async (did) => ({ did, h: await resolveHandle(did) })));
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const { did, h } of pairs) next[did] = h;
      setInviterHandles((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [receivedGroupInvites, inviterHandles, resolveHandle]);

  useEffect(() => {
    const dids = [...new Set(pendingWelcomes.map((w) => w.groupId).filter((d) => !welcomeHandles[d]))];
    if (dids.length === 0) return;
    let cancelled = false;
    (async () => {
      const pairs = await Promise.all(dids.map(async (did) => ({ did, h: await resolveHandle(did) })));
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const { did, h } of pairs) next[did] = h;
      setWelcomeHandles((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingWelcomes, welcomeHandles, resolveHandle]);

  // ---- 页面显示：先校验会话有效性，再主动轮询一次 ------------------------
  //
  // ⚠️ 必须在这里校验 token，因为小程序有两条路径**绕过 login 页**直接到本页：
  //   1. 热启动：小程序在后台被再次打开，微信恢复到**当前页**，login 的 useEffect 不执行；
  //   2. 下方的 `if (session) return` 短路：内存里有 session 就直接放行。
  // 不校验的话，过期 token 会一直"看起来已登录"，直到用户操作才 401。
  useDidShow(
    useCallback((): void => {
      void (async () => {
        const ok = await ensureValidSession();
        if (!ok) {
          // 会话已失效（validateAccessToken 内部已清空 session 并置 sessionExpired）
          await Taro.reLaunch({ url: '/pages/login/index' });
          return;
        }
        void pollNow();
        void loadConversations();
      })();
    }, [ensureValidSession, pollNow, loadConversations]),
  );

  useEffect(() => {
    const hide = (): void => {
      poller?.stop();
    };
    Taro.onAppHide?.(hide);
    return () => {
      Taro.offAppHide?.(hide);
    };
  }, [poller]);

  // ---- 导航 --------------------------------------------------------------
  const navigateToChat = useCallback(
    async (groupId: string, isGroup: boolean): Promise<void> => {
      // isGroup 必须显式传给 chat-view：群聊模式（发送者头像、群信息、
      // ⋮ → GroupSettings）与 1:1 模式共用同一个页面。
      const url = `/pages/pkg-chat/chat-view/index?conversationId=${encodeURIComponent(groupId)}&isGroup=${isGroup ? '1' : '0'}`;
      if (forwardPath) {
        // 文件转发：走文件消息通道（重新加密上传，接收端仍是文件消息）
        try {
          await sendFileMessage(groupId, forwardPath, forwardName, forwardMime, forwardSize);
        } catch (err) {
          console.error('chat-list: 文件转发发送失败', err);
          Taro.showToast({ title: t('chatview.send'), icon: 'none' });
          return;
        }
        await Taro.redirectTo({ url });
        return;
      }
      if (forwardText) {
        try {
          await sendMessage(groupId, forwardText);
        } catch (err) {
          console.error('chat-list: 转发发送失败', err);
        }
        await Taro.redirectTo({ url });
        return;
      }
      await Taro.navigateTo({ url });
    },
    [forwardText, forwardPath, forwardName, forwardMime, forwardSize, sendMessage, sendFileMessage, t],
  );

  const openCreateGroup = useCallback(async (): Promise<void> => {
    setMenuVisible(false);
    await Taro.navigateTo({ url: '/pages/pkg-chat/create-group/index' });
  }, []);

  const openAddFriend = useCallback(async (): Promise<void> => {
    setMenuVisible(false);
    await Taro.navigateTo({ url: '/pages/pkg-chat/qr-display/index' });
  }, []);

  const openScan = useCallback(async (): Promise<void> => {
    setMenuVisible(false);
    await Taro.navigateTo({ url: '/pages/pkg-chat/qr-scan/index' });
  }, []);

  const openSettings = useCallback(async (): Promise<void> => {
    setMenuVisible(false);
    await Taro.navigateTo({ url: '/pages/settings/index' });
  }, []);

  const openBlockList = useCallback(async (): Promise<void> => {
    setMenuVisible(false);
    await Taro.navigateTo({ url: '/pages/block-list/index' });
  }, []);

  // ---- 长按行 → 删除好友（小程序替代 web 的右滑） -----------------------
  const confirmDeleteRow = useCallback(
    async (row: ConversationRow): Promise<void> => {
      const confirmRes = await Taro.showModal({
        title: t('common.delete'),
        content: row.displayName,
      });
      if (!confirmRes.confirm) return;
      setSwipe(null);
      await deleteFriend(row.conversationId);
    },
    [t, deleteFriend],
  );

  // ---- 退出登录（两次备份密码） -----------------------------------------
  const handleLogoutPress = useCallback((): void => {
    setMenuVisible(false);
    setBackupPwd('');
    setBackupPwdConfirm('');
    setLogoutError(null);
    setLogoutStatus('idle');
    setLogoutModalVisible(true);
  }, []);

  const handleLogoutConfirm = useCallback(async (): Promise<void> => {
    if (logoutBusyRef.current) return; // 重入闸门：让步窗口内的连点直接吞掉
    if (!backupPwd) {
      setLogoutError(t('chatlist.enterPassword'));
      setLogoutStatus('error');
      return;
    }
    if (backupPwd !== backupPwdConfirm) {
      setLogoutError(t('chatlist.passwordMismatch'));
      setLogoutStatus('error');
      return;
    }
    logoutBusyRef.current = true;
    setLogoutStatus('backing_up');
    setLogoutError(null);
    try {
      // ⚠️ 必须先展示**原生** loading，再进入 backupIdentity：
      //    backupIdentity 在发起网络请求（putIdentityBackup）之前是一个
      //    纯 JS 同步大块 —— 前置的 storage 读取全是一次 resolve 的微任务
      //    级联，中间穿插 PBKDF2 10 万次迭代（桌面实测 472ms，真机 ES5
      //    低端机 1.5~5s+）+ JSON 序列化 + AES-GCM。若直接 await，React
      //    的 'backing_up' 渲染（按钮 disabled / 「备份中…」文案）永远
      //    排不上号 —— 用户点确认后整个小程序冻结数秒，真机表现为
      //    「卡死」（2026-09-29 真机反馈）。
      //    Taro.showLoading 是原生组件：JS 线程冻结期间依然显示动画；
      //    mask:true 让原生层直接拦截触摸，连点也从根上防住。
      await Taro.showLoading({ title: t('chatlist.backingUp'), mask: true });
      await backupIdentity(backupPwd);
      setLogoutModalVisible(false);
      await logout();
      await Taro.reLaunch({ url: '/pages/login/index' });
    } catch (err) {
      setLogoutError(err instanceof Error ? err.message : t('chatlist.backupFailed'));
      setLogoutStatus('error');
    } finally {
      Taro.hideLoading();
      logoutBusyRef.current = false;
    }
  }, [backupPwd, backupPwdConfirm, t, backupIdentity, logout]);

  // ---- 三个邀请/握手区块的数据 ------------------------------------------
  const pendingReceivedInvites = useMemo(
    () => receivedGroupInvites.filter((i) => i.status === 'pending'),
    [receivedGroupInvites],
  );

  const groupedSentInvites = useMemo(() => {
    const active = pendingInvites.filter((i) => i.status === 'pending' || i.status === 'accepted');
    const map = new Map<string, typeof active>();
    for (const inv of active) {
      const arr = map.get(inv.groupId) ?? [];
      arr.push(inv);
      map.set(inv.groupId, arr);
    }
    return [...map.entries()];
  }, [pendingInvites]);

  const myAvatarLetter = (session?.handle ?? myDisplayName ?? '?').slice(0, 1).toUpperCase();
  const summaryName = myDisplayName || myHandle || session?.handle || '';

  if (!ready) {
    return (
      <View className="chatlist chatlist--center">
        <LogoSpinner />
      </View>
    );
  }

  return (
    <View className="chatlist">
      {/* ---------------- 顶栏 ---------------- */}
      {forwarding ? (
        <View className="chatlist__header chatlist__header--forward">
          <Button
            className="chatlist__iconBtn chatlist__iconBtn--ghost"
            onClick={async () => {
              await Taro.navigateBack();
            }}
          >
            {t('common.cancel')}
          </Button>
          <Text className="chatlist__headerTitle">{t('chatlist.selectForwardTarget')}</Text>
          <View className="chatlist__headerActions" />
        </View>
      ) : (
        <View className="chatlist__header">
          <Text className="chatlist__headerTitle">{t('chatlist.title')}</Text>
          <View className="chatlist__headerActions">
            <Button className="chatlist__iconBtn" onClick={openCreateGroup}>
              {t('chatlist.addGroup')}
            </Button>
            <Button className="chatlist__iconBtn" onClick={openAddFriend}>
              {t('chatlist.addFriend')}
            </Button>
            <View className="chatlist__userBtn" onClick={() => setMenuVisible((v) => !v)}>
              {myAvatarUrl && !myAvatarError ? (
                <Image
                  className="chatlist__userAvatar"
                  src={myAvatarUrl}
                  mode="aspectFill"
                  onError={() => setMyAvatarError(true)}
                />
              ) : (
                <View className="chatlist__userAvatar chatlist__userAvatar--fallback">
                  <Text className="chatlist__userAvatarText">{myAvatarLetter}</Text>
                </View>
              )}
              <View className="chatlist__userInfo">
                <Text className="chatlist__userName">{summaryName}</Text>
                {myHandle ? <Text className="chatlist__userHandle">@{myHandle}</Text> : null}
              </View>
            </View>
          </View>
        </View>
      )}

      {/* ---------------- 列表 ---------------- */}
      <ScrollView className="chatlist__list" scrollY>
        {/* ① 收到的群邀请 */}
        {pendingReceivedInvites.length > 0 ? (
          <View className="chatlist__section">
            <Text className="chatlist__sectionTitle">{t('chatlist.groupInvitations')}</Text>
            {pendingReceivedInvites.map((invite) => (
              <View key={invite.inviteId} className="chatlist__inviteRow">
                <View className="chatlist__inviteInfo">
                  <Text className="chatlist__inviteTitle">{invite.groupName}</Text>
                  <Text className="chatlist__inviteStatus">
                    {t('chatlist.fromHandle', {
                      handle: inviterHandles[invite.inviterDid] ?? invite.inviterDid,
                    })}
                  </Text>
                </View>
                <Button
                  className="chatlist__inviteBtn chatlist__inviteBtn--primary"
                  onClick={() => void respondToGroupInvite(invite.inviteId, true)}
                >
                  {t('common.accept')}
                </Button>
                <Button
                  className="chatlist__inviteBtn"
                  onClick={() => void respondToGroupInvite(invite.inviteId, false)}
                >
                  {t('common.decline')}
                </Button>
              </View>
            ))}
          </View>
        ) : null}

        {/* ② 已发群邀请进度 */}
        {groupedSentInvites.length > 0 ? (
          <View className="chatlist__section">
            <Text className="chatlist__sectionTitle">{t('chatlist.pendingGroupInvites')}</Text>
            {groupedSentInvites.map(([gid, invites]) => {
              const acceptedCount = invites.filter((i) => i.status === 'accepted').length;
              const pendingCount = invites.filter((i) => i.status === 'pending').length;
              const isExistingGroup = groupInfos.some((g) => g.groupId === gid);
              return (
                <View key={gid} className="chatlist__inviteRow">
                  <View className="chatlist__inviteInfo">
                    <Text className="chatlist__inviteTitle">{invites[0]?.groupName}</Text>
                    <Text className="chatlist__inviteStatus">
                      {t('chatlist.inviteStatus', { accepted: acceptedCount, pending: pendingCount })}
                    </Text>
                  </View>
                  {acceptedCount > 0 ? (
                    <Button
                      className="chatlist__inviteBtn chatlist__inviteBtn--primary"
                      onClick={async () => {
                        try {
                          if (isExistingGroup) {
                            await addAcceptedMembersToGroup(gid);
                          } else {
                            await createGroupFromPendingInvites(gid);
                          }
                        } catch (err) {
                          await Taro.showToast({
                            title: err instanceof Error ? err.message : String(err),
                            icon: 'none',
                          });
                        }
                      }}
                    >
                      {isExistingGroup ? t('chatlist.add') : t('chatlist.create')}
                    </Button>
                  ) : null}
                  <Button
                    className="chatlist__inviteBtn"
                    onClick={async () => {
                      for (const inv of invites) {
                        await cancelGroupInvite(inv.inviteId);
                      }
                    }}
                  >
                    {t('common.cancel')}
                  </Button>
                </View>
              );
            })}
          </View>
        ) : null}

        {/* ③ 待处理握手 */}
        {pendingWelcomes.length > 0 ? (
          <View className="chatlist__section">
            <Text className="chatlist__sectionTitle">
              {t('chatlist.pendingWelcomes', { count: pendingWelcomes.length })}
            </Text>
            {pendingWelcomes.map((w: PendingWelcome) => {
              const h = welcomeHandles[w.groupId];
              const label = h && h !== w.groupId ? `@${h}` : w.groupId;
              return (
                <View key={w.queueId} className="chatlist__inviteRow">
                  <View className="chatlist__inviteInfo">
                    <Text className="chatlist__inviteTitle">{label}</Text>
                    <Text className="chatlist__inviteStatus">
                      {t('chatlist.waitingWelcome', { time: formatTimeAgo(w.createdAt, t) })}
                    </Text>
                  </View>
                  <Button
                    className="chatlist__inviteBtn chatlist__inviteBtn--danger"
                    onClick={() => void deletePendingWelcome(w.queueId)}
                  >
                    {t('common.delete')}
                  </Button>
                </View>
              );
            })}
          </View>
        ) : null}

        {/* ④ 会话行 */}
        {rows.length === 0 ? (
          !loading ? (
            <View className="chatlist__empty">
              <Text className="chatlist__emptyTitle">{t('chatlist.noConversations')}</Text>
              <Text className="chatlist__hint">{t('chatlist.noConversationsHint')}</Text>
            </View>
          ) : null
        ) : (
          rows.map((row) => {
            const blocked = row.lastMessage ? blockList.includes(row.lastMessage.fromDid) : false;
            const preview = blocked
              ? t('chatlist.blocked')
              : row.lastMessage
                ? row.lastMessage.kind === 'file' && row.lastMessage.fileMeta
                  ? t('chatlist.filePreview', { name: row.lastMessage.fileMeta.fileName })
                  : row.lastMessage.plaintext.slice(0, 40) +
                    (row.lastMessage.plaintext.length > 40 ? '…' : '')
                : t('chatlist.noMessages');
            const offset = swipe?.id === row.conversationId ? swipe.offset : 0;
            return (
              <View key={row.conversationId} className="chatlist__swipeRow">
                {/* 垫底的删除按钮：行左滑时露出 */}
                <View
                  className="chatlist__swipeDelete"
                  style={{ opacity: offset < 0 ? 1 : 0 }}
                  onClick={() => void confirmDeleteRow(row)}
                >
                  <Text className="chatlist__swipeDeleteText">{t('common.delete')}</Text>
                </View>
                <View
                  className="chatlist__row"
                  style={{
                    transform: `translateX(${offset}px)`,
                    transition:
                      swipeTouchingId === row.conversationId
                        ? 'none'
                        : 'transform 0.18s ease-out',
                  }}
                  onTouchStart={(e) => {
                    const t0 = touchOf(e);
                    if (!t0) return;
                    swipeTouch.current = {
                      x: t0.x,
                      y: t0.y,
                      base: offset,
                      horizontal: null,
                    };
                    setSwipeTouchingId(row.conversationId);
                  }}
                  onTouchMove={(e) => {
                    const st = swipeTouch.current;
                    const t0 = touchOf(e);
                    if (!st || !t0) return;
                    const dx = t0.x - st.x;
                    const dy = t0.y - st.y;
                    if (st.horizontal === null) {
                      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
                      st.horizontal = Math.abs(dx) > Math.abs(dy);
                    }
                    if (!st.horizontal) return;
                    setSwipe({
                      id: row.conversationId,
                      offset: Math.max(-SWIPE_W, Math.min(0, st.base + dx)),
                    });
                  }}
                  onTouchEnd={() => {
                    const st = swipeTouch.current;
                    swipeTouch.current = null;
                    setSwipeTouchingId('');
                    if (!st?.horizontal) return;
                    swipeGuardRef.current = true;
                    setTimeout(() => {
                      swipeGuardRef.current = false;
                    }, 400);
                    setSwipe((prev) => {
                      const cur = prev?.id === row.conversationId ? prev.offset : 0;
                      return cur < -SWIPE_W / 2
                        ? { id: row.conversationId, offset: -SWIPE_W }
                        : null;
                    });
                  }}
                  onClick={() => {
                    if (swipeGuardRef.current) return;
                    // 已处于左滑展开态：先收起，不进入会话
                    if (swipe && swipe.offset !== 0) {
                      setSwipe(null);
                      return;
                    }
                    void navigateToChat(row.conversationId, row.isGroup);
                  }}
                >
                <View className="chatlist__avatarWrap">
                  {row.avatarUrl ? (
                    <Image className="chatlist__avatarImg" src={row.avatarUrl} mode="aspectFill" />
                  ) : (
                    <View className="chatlist__avatar">
                      <Text className="chatlist__avatarText">
                        {(row.displayName || '?').slice(0, 1).toUpperCase()}
                      </Text>
                    </View>
                  )}
                  {row.unreadCount > 0 ? (
                    <View className="chatlist__badge">
                      <Text className="chatlist__badgeText">
                        {row.unreadCount > 99 ? '99+' : row.unreadCount}
                      </Text>
                    </View>
                  ) : null}
                </View>

                <View className="chatlist__content">
                  <View className="chatlist__topLine">
                    <Text className="chatlist__name">
                      {row.isGroup ? t('common.groupPrefix') : ''}
                      {row.displayName}
                    </Text>
                    {row.lastMessage ? (
                      <Text className="chatlist__time">{formatTimeAgo(row.lastMessage.createdAt, t)}</Text>
                    ) : null}
                  </View>
                  {row.handle ? (
                    <Text className="chatlist__handle">@{row.handle}</Text>
                  ) : null}
                  <Text className="chatlist__preview">{preview}</Text>
                </View>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      {/* ---------------- 头像弹出菜单 ---------------- */}
      {menuVisible ? (
        <>
          <View className="chatlist__menuMask" onClick={() => setMenuVisible(false)} />
          <View className="chatlist__menu">
            <View className="chatlist__menuItem" onClick={openScan}>
              <Text className="chatlist__menuItemText">{t('chatlist.scan')}</Text>
            </View>
            <View className="chatlist__menuItem" onClick={openSettings}>
              <Text className="chatlist__menuItemText">{t('chatlist.settings')}</Text>
            </View>
            <View className="chatlist__menuItem" onClick={openBlockList}>
              <Text className="chatlist__menuItemText">{t('chatlist.blockList')}</Text>
            </View>
            {/* 🔴 web 端此项被 {!isEmbedContext() && ...} 包裹；小程序无嵌入模式，无条件渲染 */}
            <View className="chatlist__menuItem" onClick={handleLogoutPress}>
              <Text className="chatlist__menuItemText chatlist__menuItemText--danger">
                {t('chatlist.logout')}
              </Text>
            </View>
          </View>
        </>
      ) : null}

      {/* ---------------- 退出登录 Modal ---------------- */}
      {logoutModalVisible ? (
        <>
          <View className="chatlist__modalMask" onClick={() => setLogoutModalVisible(false)} />
          <View className="chatlist__modalCard">
            <Text className="chatlist__modalTitle">{t('chatlist.logoutTitle')}</Text>
            <Text className="chatlist__modalMessage">{t('chatlist.logoutMessage')}</Text>
            <Input
              className="chatlist__modalInput"
              value={backupPwd}
              password
              disabled={logoutStatus === 'backing_up'}
              placeholder={t('chatlist.passwordPlaceholder')}
              onInput={(e) => setBackupPwd(e.detail.value)}
            />
            <Input
              className="chatlist__modalInput"
              value={backupPwdConfirm}
              password
              disabled={logoutStatus === 'backing_up'}
              placeholder={t('chatlist.confirmPasswordPlaceholder')}
              onInput={(e) => setBackupPwdConfirm(e.detail.value)}
            />
            {logoutError ? <Text className="chatlist__modalError">{logoutError}</Text> : null}
            <View className="chatlist__modalButtons">
              <Button
                className="chatlist__modalBtn"
                onClick={() => setLogoutModalVisible(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                className="chatlist__modalBtn chatlist__modalBtn--primary"
                disabled={logoutStatus === 'backing_up'}
                onClick={() => void handleLogoutConfirm()}
              >
                {logoutStatus === 'backing_up'
                  ? t('chatlist.backingUp')
                  : t('chatlist.backupAndLogout')}
              </Button>
            </View>
          </View>
        </>
      ) : null}
    </View>
  );
}
