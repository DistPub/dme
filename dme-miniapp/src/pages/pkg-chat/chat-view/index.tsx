/**
 * pages/pkg-chat/chat-view/index.tsx - 会话视图完整版（1:1 + 群聊）。
 *
 * 对齐 web `dme-client/src/ui/ChatViewScreen.tsx`：
 *   - 分页加载（最近 50 条，向上滚动加载更早）
 *   - 文本消息 MessageBubble / 文件消息 FileMessageBubble
 *   - reactions 表情 pill + EmojiPicker + 长按 MessageActionMenu
 *   - 📄 附件按钮 → 图片 / 视频 / 聊天文件 三选一
 *   - 🎤 按住说话（语音模式）：wx.getRecorderManager 录 aac 语音，
 *     走 sendFileMessage 文件消息通道发送（接收端音频播放卡现成）
 *   - 多行 Textarea（autoHeight）
 *   - 群聊：发送者头像/昵称、群系统消息灰条、群邀请卡片、
 *           解散/被移出/已离开只读输入条
 *   - 1:1：屏蔽状态提示，⋮ → DmSettings；群聊 ⋮ → GroupSettings
 *
 * 小程序差异（见 IMPROVEMENT-PLAN.md §4.2）：
 *   - web 用 inverted FlatList（新消息在底部 + 向下翻页加载旧消息）；
 *     小程序 ScrollView 不支持 inverted，改为「旧→新从上到下渲染 +
 *     scrollIntoView 锚点 + onScrollToUpper 加载旧消息」。
 *   - web 用 measureInWindow 实测气泡坐标；小程序用页面级
 *     createSelectorQuery().boundingClientRect()（视口坐标，与
 *     position:fixed 浮层同一坐标系）。
 *   - EmojiPicker / MessageActionMenu 打开期间隐藏 <Textarea>：
 *     原生组件层级最高，会盖住浮层。
 *   - 附件用 chooseMedia / chooseMessageFile 替代 DocumentPicker；
 *     保存用 saveImageToPhotosAlbum / saveVideoToPhotosAlbum /
 *     openDocument 替代 expo Sharing。
 *
 * 参数：/pages/pkg-chat/chat-view/index?conversationId=<DID|群ID>&isGroup=1
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, Textarea, Image } from '@tarojs/components';
import Taro, { useRouter, useDidShow } from '@tarojs/taro';

import { useApp } from '../../../state/AppContext';
import { useI18n } from '../../../i18n/I18nContext';
import type { StoredMessage } from '../../../storage/db';
import type { GroupInviteRequest } from '../../../protocol/group-message';
import { MessageBubble } from '../../../components/MessageBubble';
import { FileMessageBubble } from '../../../components/FileMessageBubble';
import { EmojiPicker, type OverlayLayout } from '../../../components/EmojiPicker';
import { MessageActionMenu } from '../../../components/MessageActionMenu';
import {
  resolveHandleCached,
  getProfileCached,
  getProfilesCached,
} from '../../../atproto/profile-cache';
import { useWebTitle } from '../../../utils/web-title';
import type { TapPos } from '../../../utils/screen';
import { touchOf } from '../../../utils/screen';
import {
  startVoiceRecording,
  stopVoiceRecording,
  cancelVoiceRecording,
  VOICE_FORMAT_EXT,
  VOICE_MIME_TYPE,
} from '../../../platform/recorder';
import './index.scss';

interface SenderProfile {
  displayName: string;
  handle: string;
  avatarUrl: string | null;
}

const PAGE_SIZE = 50;

/** 文件后缀 → MIME（chooseMessageFile 不带 mimeType）。 */
const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  aac: 'audio/aac',
  amr: 'audio/amr',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
};

function mimeFromName(name: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name);
  const ext = m?.[1]?.toLowerCase();
  return (ext && EXT_MIME[ext]) || 'application/octet-stream';
}

/** 消息 id → 可用作元素 id / selector 的安全字符串。 */
function anchorIdOf(msgId: string): string {
  return `m-${msgId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export default function ChatViewPage(): React.JSX.Element {
  const { t } = useI18n();
  const router = useRouter();
  const conversationId = useMemo(
    () => decodeURIComponent(router.params.conversationId ?? ''),
    [router.params.conversationId],
  );
  const isGroup = router.params.isGroup === '1' || router.params.isGroup === 'true';

  const {
    session,
    storage,
    pds,
    chatListVersion,
    sendMessage,
    sendFileMessage,
    retryUploadFileMessage,
    downloadFile,
    sendReaction,
    deleteMessage,
    receivedGroupInvites,
    respondToGroupInvite,
    markConversationAsRead,
    blockList,
    setActiveConversation,
    pollNow,
  } = useApp();

  /** 消息列表（**新→旧**，与 getMessagesPaginated 返回顺序一致）。 */
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  /** 键盘高度（px，onKeyboardHeightChange 实测）：输入条上移量。 */
  const [kbHeight, setKbHeight] = useState(0);
  /** textarea 行数（不使用 autoHeight —— 它会忽略 height 导致初始两行）。 */
  const [inputLines, setInputLines] = useState(1);
  const [displayName, setDisplayName] = useState(isGroup ? t('common.loading') : conversationId);
  const [groupCreatorHandle, setGroupCreatorHandle] = useState('');
  const [friendAvatarUrl, setFriendAvatarUrl] = useState<string | null>(null);
  const [friendAvatarError, setFriendAvatarError] = useState(false);
  const [friendHandle, setFriendHandle] = useState('');
  const [senderProfiles, setSenderProfiles] = useState<Record<string, SenderProfile>>({});
  const senderProfileCacheRef = useRef<Record<string, SenderProfile>>({});
  const [ownProfile, setOwnProfile] = useState<SenderProfile | null>(null);
  const [dissolved, setDissolved] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [left, setLeft] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<StoredMessage | null>(null);
  const [pickerLayout, setPickerLayout] = useState<OverlayLayout | null>(null);
  const [actionMenuTarget, setActionMenuTarget] = useState<StoredMessage | null>(null);
  const [actionMenuLayout, setActionMenuLayout] = useState<OverlayLayout | null>(null);
  /** ScrollView scrollIntoView 锚点（指向「视觉上需要停留」的那条消息）。 */
  const [scrollAnchor, setScrollAnchor] = useState('');
  /** 输入条模式：文本 / 语音（🎤 切换）。 */
  const [voiceMode, setVoiceMode] = useState(false);
  /** 录音浮层（正在录音）。 */
  const [recordingUi, setRecordingUi] = useState(false);
  /** 录音浮层「取消态」：手指已滑入上滑取消区。 */
  const [recordCancelUi, setRecordCancelUi] = useState(false);
  /** 录音已进行秒数（浮层倒计时，上限 60s 由 recorder 层强制停止）。 */
  const [recordSeconds, setRecordSeconds] = useState(0);

  const messagesRef = useRef<StoredMessage[]>([]);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // ---- 按住说话手势状态（ref 同步读写，touch 事件里不依赖闭包 state） ----

  const voiceGestureRef = useRef<{
    /** 手指是否还按着（touchend/touchcancel 后置 false）。 */
    active: boolean;
    /** 是否已滑入取消区。 */
    cancelled: boolean;
    /** 是否已在收尾（防 60s 自动停止 + 松手双重触发）。 */
    finishing: boolean;
    startX: number;
    startY: number;
  }>({ active: false, cancelled: false, finishing: false, startX: 0, startY: 0 });
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopRecordTimer = useCallback((): void => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
  }, []);

  // 页面卸载时若在录音 → 取消（临时文件作废，不留半条消息）
  useEffect(() => () => {
    stopRecordTimer();
    cancelVoiceRecording();
  }, [stopRecordTimer]);

  const myDid = session?.did ?? '';
  const isBlocked = !isGroup && blockList.includes(conversationId);

  useWebTitle(isGroup ? `${t('common.groupPrefix')}${displayName}` : displayName);

  // ---- 数据加载 -----------------------------------------------------------

  const loadRecentMessages = useCallback(async (): Promise<void> => {
    if (!storage) return;
    const { messages: msgs, hasMore: more } = await storage.getMessagesPaginated(
      conversationId,
      undefined,
      PAGE_SIZE,
    );
    const blockedSet = new Set(blockList);
    const next = msgs.filter((m) => !blockedSet.has(m.fromDid));
    if (!mountedRef.current) return;
    setMessages(next);
    setHasMore(more);
    // 锚定到最新一条（视觉底部）
    setScrollAnchor(next.length > 0 ? anchorIdOf(next[0]!.id) : '');
  }, [storage, conversationId, blockList]);

  const loadOlderMessages = useCallback(async (): Promise<void> => {
    if (!storage || !hasMore || loadingMore || messagesRef.current.length === 0) return;
    setLoadingMore(true);
    try {
      // messages 是新→旧；最后一条即当前最旧一条
      const oldestId = messagesRef.current[messagesRef.current.length - 1]!.id;
      const { messages: older, hasMore: more } = await storage.getMessagesPaginated(
        conversationId,
        oldestId,
        PAGE_SIZE,
      );
      const blockedSet = new Set(blockList);
      const next = older.filter((m) => !blockedSet.has(m.fromDid));
      // 先把锚点定在「当前最旧一条」，prepend 后视口停留不动
      setScrollAnchor(anchorIdOf(oldestId));
      setMessages((prev) => [...prev, ...next]);
      setHasMore(more);
    } catch (err) {
      console.error('loadOlderMessages failed:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [storage, conversationId, hasMore, loadingMore, blockList]);

  useEffect(() => {
    setActiveConversation(conversationId);
    void loadRecentMessages();
    void markConversationAsRead(conversationId).catch((err: unknown) => {
      console.error('markConversationAsRead failed:', err);
    });
    void pollNow();
    return () => {
      setActiveConversation(null);
    };
  }, [loadRecentMessages, markConversationAsRead, conversationId, setActiveConversation, pollNow]);

  useDidShow(() => {
    void pollNow();
  });

  // chatListVersion 变化 → 合并新消息（保留本地尚未确认的状态更新，
  // 例如文件上传进度），有新消息时跳到底部。
  useEffect(() => {
    if (!storage) return;
    if (messagesRef.current.length === 0) {
      void loadRecentMessages().catch((err: unknown) => {
        console.error('loadRecentMessages failed:', err);
      });
    } else {
      const limit = Math.max(PAGE_SIZE, messagesRef.current.length);
      void storage
        .getMessagesPaginated(conversationId, undefined, limit)
        .then(({ messages: recent }) => {
          if (recent.length === 0 || !mountedRef.current) return;
          const prev = messagesRef.current;
          const existingIds = new Set(prev.map((m) => m.id));
          const newMessages = recent.filter((m) => !existingIds.has(m.id));
          if (newMessages.length === 0 && prev.every((m) => recent.some((r) => r.id === m.id))) {
            // 无新消息，但已有消息可能更新了（进度/reactions）→ 原位替换
            const recentMap = new Map(recent.map((m) => [m.id, m]));
            const merged = prev.map((m) => recentMap.get(m.id) ?? m);
            messagesRef.current = merged;
            setMessages(merged);
            return;
          }
          const recentMap = new Map(recent.map((m) => [m.id, m]));
          const merged = [...newMessages, ...prev.filter((m) => recentMap.has(m.id)).map((m) => recentMap.get(m.id) ?? m)];
          messagesRef.current = merged;
          setMessages(merged);
          if (newMessages.length > 0 && merged[0]) {
            setScrollAnchor(anchorIdOf(merged[0].id));
          }
        })
        .catch((err: unknown) => {
          console.error('merge messages failed:', err);
        });
    }
    void storage.markMessagesAsRead(conversationId).catch((err: unknown) => {
      console.error('markMessagesAsRead failed:', err);
    });
  }, [chatListVersion, storage, conversationId, loadRecentMessages]);

  // ---- 群聊：批量解析消息发送者资料 ---------------------------------------

  useEffect(() => {
    if (!isGroup || !session || !pds) return;

    const senderDids = [...new Set(messages.map((m) => m.fromDid))]
      .filter((did) => did !== session.did);
    if (senderDids.length === 0) return;

    // 先把缓存里已有的条目同步进 state（修复 web 注释中提到的取消竞态）
    setSenderProfiles((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const did of senderDids) {
        const entry = senderProfileCacheRef.current[did];
        if (entry && prev[did] !== entry) {
          next[did] = entry;
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    const missing = senderDids.filter((did) => !senderProfileCacheRef.current[did]);
    if (missing.length === 0) return;

    void (async () => {
      try {
        const profiles = await getProfilesCached(pds, missing);
        for (const [did, profile] of Object.entries(profiles)) {
          senderProfileCacheRef.current[did] = {
            displayName: profile.displayName ?? '',
            handle: profile.handle ?? did,
            avatarUrl: profile.avatar ?? null,
          };
        }
      } catch (err) {
        console.error('Failed to batch resolve sender profiles', missing, err);
      }

      const stillMissing = missing.filter((did) => !senderProfileCacheRef.current[did]);
      if (stillMissing.length > 0) {
        await Promise.all(
          stillMissing.map(async (did) => {
            try {
              const handle = await resolveHandleCached(did);
              senderProfileCacheRef.current[did] = { displayName: '', handle, avatarUrl: null };
            } catch {
              senderProfileCacheRef.current[did] = { displayName: '', handle: did, avatarUrl: null };
            }
          }),
        );
      }

      if (!mountedRef.current) return;
      setSenderProfiles((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const did of missing) {
          const entry = senderProfileCacheRef.current[did];
          if (entry && prev[did] !== entry) {
            next[did] = entry;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    })();
  }, [messages, isGroup, session, pds]);

  // ---- 群聊：自己的资料（自己的头像） --------------------------------------

  useEffect(() => {
    if (!isGroup || !session?.did || !pds) return;
    void (async () => {
      try {
        const profile = await getProfileCached(pds, session.did);
        if (!mountedRef.current || !profile) return;
        const next: SenderProfile = {
          displayName: profile.displayName ?? '',
          handle: profile.handle ?? '',
          avatarUrl: profile.avatar ?? null,
        };
        setOwnProfile((prev) =>
          prev &&
          prev.displayName === next.displayName &&
          prev.handle === next.handle &&
          prev.avatarUrl === next.avatarUrl
            ? prev
            : next,
        );
      } catch (err) {
        console.error('Failed to fetch own profile for avatar:', err);
      }
    })();
  }, [session?.did, isGroup, chatListVersion, pds]);

  // ---- 标题 / 对方资料 / 群信息 --------------------------------------------

  useEffect(() => {
    if (isGroup) {
      const loadGroupInfo = async (): Promise<void> => {
        if (!storage) return;
        const info = await storage.getGroupInfo(conversationId);
        if (!info || !mountedRef.current) return;
        setDisplayName(info.groupName);
        setDissolved(info.dissolved ?? false);
        setRemoved(info.removed ?? false);
        setLeft(info.left ?? false);
        try {
          const handle = await resolveHandleCached(info.creatorDid);
          if (mountedRef.current && handle !== info.creatorDid) {
            setGroupCreatorHandle(handle);
          }
        } catch (err) {
          console.error('Failed to resolve creator handle for', info.creatorDid, err);
        }
      };
      void loadGroupInfo().catch((err: unknown) => console.error('loadGroupInfo failed:', err));
    } else {
      let cancelled = false;
      (async () => {
        try {
          const handle = await resolveHandleCached(conversationId);
          if (!cancelled && handle !== conversationId) {
            setDisplayName(handle);
            setFriendHandle(handle);
          }
        } catch (err) {
          console.error('Failed to resolve handle for', conversationId, err);
        }
        if (!cancelled && pds) {
          try {
            const profile = await getProfileCached(pds, conversationId);
            if (cancelled || !profile) return;
            if (profile.displayName) setDisplayName(profile.displayName);
            if (profile.handle) setFriendHandle(profile.handle);
            if (profile.avatar) setFriendAvatarUrl(profile.avatar);
          } catch (err) {
            console.error('Failed to fetch friend profile for', conversationId, err);
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }
  }, [conversationId, isGroup, storage, chatListVersion, pds]);

  // ---- 发送 / 交互 ---------------------------------------------------------

  const onSend = useCallback(async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || sending || isBlocked) return;
    setSending(true);
    try {
      await sendMessage(conversationId, trimmed);
      setText('');
      setInputLines(1);
      // 🔴 焦点相关一律不碰：受控 focus（onFocus→setState→重渲染→再写
      // focus 属性）会造成原生「聚焦↔失焦」乒乓死循环，键盘永远弹不起来。
      // 点击发送按钮不失焦由 holdKeyboard 保证，无需程序化重拉。
    } catch (err) {
      console.error('Send failed:', err);
      Taro.showToast({
        title: err instanceof Error ? err.message : t('chatview.send'),
        icon: 'none',
      });
    } finally {
      setSending(false);
    }
  }, [text, sending, isBlocked, sendMessage, conversationId, t]);

  // ---- 按住说话 -------------------------------------------------------------

  const toggleVoiceMode = useCallback((): void => {
    setVoiceMode((prev) => {
      // 切到语音模式时 Textarea 卸载 → 原生键盘收起；清掉键盘顶起 padding
      if (!prev) setKbHeight(0);
      return !prev;
    });
  }, []);

  /** 松手后的统一收尾：stop → 太短丢弃 / 走文件消息通道发送。 */
  const finishVoiceSend = useCallback(async (): Promise<void> => {
    if (voiceGestureRef.current.finishing) return;
    voiceGestureRef.current.finishing = true;
    stopRecordTimer();
    try {
      // 🔴 60s 到时底层已自动 onStop：recorder 层会把结果暂存，这里照样取到
      const rec = await stopVoiceRecording();
      if (rec.durationMs < 500) {
        Taro.showToast({ title: t('chatview.tooShort'), icon: 'none' });
        return;
      }
      const now = new Date();
      const pad = (n: number): string => String(n).padStart(2, '0');
      const name = `voice-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${VOICE_FORMAT_EXT}`;
      // 与图片/视频同一条链路：先落缓存副本 + 乐观消息 → 逐块加密上传 → 发清单
      await sendFileMessage(conversationId, rec.tempFilePath, name, VOICE_MIME_TYPE, rec.size);
    } catch (err) {
      const msgText = err instanceof Error ? err.message : String(err ?? '');
      if (msgText === '录音已取消') return; // 取消流程，静默
      console.error('Voice send failed:', err);
      Taro.showToast({ title: t('chatview.recordFailed'), icon: 'none' });
    } finally {
      voiceGestureRef.current.finishing = false;
      voiceGestureRef.current.active = false;
      setRecordingUi(false);
      setRecordCancelUi(false);
    }
  }, [conversationId, sendFileMessage, stopRecordTimer, t]);

  const onVoiceTouchStart = useCallback(
    (e: unknown): void => {
      if (isBlocked) return;
      // Taro 的 BaseEventOrig 类型不带 touches，统一走 touchOf 兜底（utils/screen）
      const touch = touchOf(e);
      if (!touch) return;
      voiceGestureRef.current.active = true;
      voiceGestureRef.current.cancelled = false;
      voiceGestureRef.current.startX = touch.x;
      voiceGestureRef.current.startY = touch.y;
      setRecordCancelUi(false);
      setRecordSeconds(0);
      setRecordingUi(true);
      startVoiceRecording()
        .then(() => {
          // 极短按：start 还没完成用户就松手 → 收尾流程已走，直接丢弃状态
          if (!voiceGestureRef.current.active) return;
          recordTimerRef.current = setInterval(() => {
            setRecordSeconds((s) => Math.min(s + 1, 60));
          }, 1000);
        })
        .catch((err: unknown) => {
          console.error('startVoiceRecording failed:', err);
          voiceGestureRef.current.active = false;
          setRecordingUi(false);
          Taro.showToast({ title: t('chatview.recordFailed'), icon: 'none' });
        });
    },
    [isBlocked, t],
  );

  const onVoiceTouchMove = useCallback((e: unknown): void => {
    const g = voiceGestureRef.current;
    if (!g.active) return;
    const touch = touchOf(e);
    if (!touch) return;
    // 上滑超过 60px 进入取消区（微信同款交互）
    const cancelZone = g.startY - touch.y > 60;
    if (cancelZone !== g.cancelled) {
      g.cancelled = cancelZone;
      setRecordCancelUi(cancelZone);
    }
  }, []);

  const onVoiceTouchEnd = useCallback((): void => {
    const g = voiceGestureRef.current;
    if (!g.active) return;
    g.active = false;
    stopRecordTimer();
    if (g.cancelled) {
      // 滑入取消区后松手 → 丢弃本次录音
      cancelVoiceRecording();
      g.finishing = false;
      setRecordingUi(false);
      setRecordCancelUi(false);
      return;
    }
    void finishVoiceSend();
  }, [finishVoiceSend, stopRecordTimer]);

  const onVoiceTouchCancel = useCallback((): void => {
    // 系统中断（来电、切后台等）：按取消处理，不发半条
    const g = voiceGestureRef.current;
    if (!g.active) return;
    g.active = false;
    stopRecordTimer();
    cancelVoiceRecording();
    g.finishing = false;
    setRecordingUi(false);
    setRecordCancelUi(false);
  }, [stopRecordTimer]);

  const handleReact = useCallback(
    async (msg: StoredMessage, emoji: string): Promise<void> => {
      setPickerTarget(null);
      setPickerLayout(null);
      try {
        await sendReaction(conversationId, msg.id, emoji);
      } catch (err) {
        console.error('sendReaction failed:', err);
      }
    },
    [sendReaction, conversationId],
  );

  const handleOpenPicker = useCallback(
    (msg: StoredMessage, pos: TapPos): void => {
      setPickerTarget(msg);
      setPickerLayout({ x: pos.x, y: pos.y, width: 0, height: 0 });
    },
    [],
  );

  const handleShowActionMenu = useCallback(
    (msg: StoredMessage, pos: TapPos): void => {
      setActionMenuTarget(msg);
      setActionMenuLayout({ x: pos.x, y: pos.y, width: 0, height: 0 });
    },
    [],
  );

  const handleCopy = useCallback((msg: StoredMessage): void => {
    void Taro.setClipboardData({ data: msg.plaintext }).catch((err: unknown) => {
      console.error('setClipboardData failed:', err);
    });
  }, []);

  const handleForward = useCallback(
    (msg: StoredMessage): void => {
      if (msg.kind === 'file' && msg.fileMeta) {
        // 文件转发 ≠ 文本转发：plaintext 是清单 JSON，必须走文件消息通道重发。
        // 前提是有本地副本（自己发的 / 已下载的）；否则提示先下载。
        const meta = msg.fileMeta;
        if (!meta.localPath) {
          Taro.showToast({ title: t('menu.forwardNeedDownload'), icon: 'none' });
          return;
        }
        void Taro.navigateTo({
          url:
            `/pages/chat-list/index?forwardPath=${encodeURIComponent(meta.localPath)}` +
            `&forwardName=${encodeURIComponent(meta.fileName)}` +
            `&forwardMime=${encodeURIComponent(meta.mimeType)}` +
            `&forwardSize=${meta.fileSize}`,
        }).catch((err: unknown) => {
          console.error('navigate to forward target failed:', err);
        });
        return;
      }
      void Taro.navigateTo({
        url: `/pages/chat-list/index?forwardText=${encodeURIComponent(msg.plaintext)}`,
      }).catch((err: unknown) => {
        console.error('navigate to forward target failed:', err);
      });
    },
    [t],
  );

  const handleDeleteMessage = useCallback(
    async (msg: StoredMessage): Promise<void> => {
      try {
        await deleteMessage(conversationId, msg.id);
        const merged = messagesRef.current.filter((m) => m.id !== msg.id);
        messagesRef.current = merged;
        setMessages(merged);
      } catch (err) {
        console.error('deleteMessage failed:', err);
      }
    },
    [deleteMessage, conversationId],
  );

  const handleAttach = useCallback(async (): Promise<void> => {
    if (isBlocked) return;
    try {
      const res = await Taro.showActionSheet({
        itemList: [t('chatview.attachImage'), t('chatview.attachVideo'), t('chatview.attachFile')],
      });
      if (res.tapIndex === 0) {
        const picked = await Taro.chooseMedia({ count: 1, mediaType: ['image'] });
        const f = picked.tempFiles?.[0];
        if (!f) return;
        const name = `image-${Date.now()}.jpg`;
        await sendFileMessage(conversationId, f.tempFilePath, name, 'image/jpeg', f.size ?? 0);
      } else if (res.tapIndex === 1) {
        const picked = await Taro.chooseMedia({ count: 1, mediaType: ['video'], maxDuration: 60 });
        const f = picked.tempFiles?.[0];
        if (!f) return;
        const name = `video-${Date.now()}.mp4`;
        await sendFileMessage(conversationId, f.tempFilePath, name, 'video/mp4', f.size ?? 0);
      } else if (res.tapIndex === 2) {
        const picked = await Taro.chooseMessageFile({ count: 1, type: 'file' });
        const f = picked.tempFiles?.[0];
        if (!f) return;
        await sendFileMessage(
          conversationId,
          f.path,
          f.name || `file-${Date.now()}`,
          mimeFromName(f.name ?? ''),
          f.size ?? 0,
        );
      }
    } catch (err) {
      // 用户取消选择不视为错误
      const msgText = err instanceof Error ? err.message : String(err ?? '');
      if (/cancel/i.test(msgText)) return;
      console.error('File pick failed:', err);
    }
  }, [isBlocked, t, conversationId, sendFileMessage]);

  /** 把 Taro API 包成严格 Promise：success 才 resolve，fail 必须 reject。
   *  🔴 不能直接 await Taro.xxx：个别 API 的 promisify 在失败分支也会 resolve，
   *     造成「保存失败却提示成功」。errMsg 统一从 fail 回调取。 */
  const wrapApi = (call: (s: () => void, f: (msg: string) => void) => void): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      call(resolve, (msg) => reject(new Error(msg)));
    });

  const handleSaveFile = useCallback(
    async (msg: StoredMessage): Promise<void> => {
      const meta = msg.fileMeta;
      if (!meta?.localPath) return;
      try {
        if (meta.mimeType.startsWith('image/')) {
          await wrapApi((ok, bad) =>
            Taro.saveImageToPhotosAlbum({
              filePath: meta.localPath!,
              success: () => ok(),
              fail: (e) => bad(e?.errMsg ?? 'saveImageToPhotosAlbum fail'),
            }),
          );
          Taro.showToast({ title: t('chatview.saveHintImage'), icon: 'success' });
        } else if (meta.mimeType.startsWith('video/')) {
          await wrapApi((ok, bad) =>
            Taro.saveVideoToPhotosAlbum({
              filePath: meta.localPath!,
              success: () => ok(),
              fail: (e) => bad(e?.errMsg ?? 'saveVideoToPhotosAlbum fail'),
            }),
          );
          Taro.showToast({ title: t('chatview.saveHintImage'), icon: 'success' });
        } else {
          // 其他文件：优先 shareFileMessage（转发到微信聊天后可另存，
          // 等价 web 的 Sharing share sheet）；低版本不支持再回退 openDocument 预览
          try {
            await wrapApi((ok, bad) =>
              (Taro as unknown as {
                shareFileMessage?: (o: {
                  filePath: string;
                  fileName?: string;
                  success: () => void;
                  fail: (e: { errMsg?: string }) => void;
                }) => void;
              }).shareFileMessage!({
                filePath: meta.localPath!,
                fileName: meta.fileName,
                success: () => ok(),
                fail: (e) => bad(e?.errMsg ?? 'shareFileMessage fail'),
              }),
            );
            Taro.showToast({ title: t('chatview.saveShared'), icon: 'none' });
          } catch {
            await wrapApi((ok, bad) =>
              Taro.openDocument({
                filePath: meta.localPath!,
                showMenu: true,
                success: () => ok(),
                fail: (e) => bad(e?.errMsg ?? 'openDocument fail'),
              }),
            );
            Taro.showToast({ title: t('chatview.saveHintFile'), icon: 'none' });
          }
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err ?? '');
        if (/cancel/i.test(raw)) return; // 用户取消不算失败
        console.error('save file failed:', raw);
        const reason = raw.replace(/^[\w.]+:? ?(?:fail)? ?/, '').slice(0, 40);
        Taro.showToast({
          title: reason ? `${t('chatview.saveFailed')}：${reason}` : t('chatview.saveFailed'),
          icon: 'none',
        });
      }
    },
    [t],
  );

  const openSettings = useCallback((): void => {
    const url = isGroup
      ? `/pages/pkg-chat/group-settings/index?groupId=${encodeURIComponent(conversationId)}`
      : `/pages/pkg-chat/dm-settings/index?friendDid=${encodeURIComponent(conversationId)}`;
    void Taro.navigateTo({ url }).catch((err: unknown) => {
      console.error('navigate to settings failed:', err);
    });
  }, [isGroup, conversationId]);

  // ---- 渲染 ---------------------------------------------------------------

  const canReact = !dissolved && !removed && !left;

  const senderIdentityFor = useCallback(
    (
      item: StoredMessage,
    ): {
      senderDisplayName?: string;
      senderHandle?: string;
      senderAvatarUrl?: string | null;
    } => {
      if (!isGroup) return {};
      const isOwn = item.fromDid === myDid;
      if (isOwn) {
        return {
          senderDisplayName: ownProfile?.displayName || ownProfile?.handle || myDid,
          senderAvatarUrl: ownProfile?.avatarUrl ?? null,
        };
      }
      const sp = senderProfiles[item.fromDid];
      return {
        senderDisplayName: sp?.displayName || sp?.handle || item.fromDid,
        senderHandle: sp?.handle,
        senderAvatarUrl: sp?.avatarUrl ?? null,
      };
    },
    [isGroup, myDid, ownProfile, senderProfiles],
  );

  const renderItem = useCallback(
    (item: StoredMessage): React.JSX.Element => {
      if (item.kind === 'group_system') {
        return (
          <View className="chatview__systemMsg">
            <Text className="chatview__systemMsgText">{item.plaintext}</Text>
          </View>
        );
      }

      if (item.kind === 'group_invite') {
        let groupName: string | null = null;
        let inviteId = '';
        try {
          const parsed = JSON.parse(item.plaintext) as GroupInviteRequest;
          groupName = parsed.groupName;
          inviteId = parsed.inviteId;
        } catch {
          // plaintext 不是合法邀请 JSON → 显示原文
        }

        const alreadyResponded = receivedGroupInvites.some(
          (i) => i.inviteId === inviteId && i.status !== 'pending',
        );

        return (
          <View className="chatview__inviteCard">
            <Text className="chatview__inviteTitle" numberOfLines={1}>
              {t('chatview.groupInviteTitle', { group: groupName ?? t('chatview.defaultGroupName') })}
            </Text>
            {alreadyResponded ? (
              <Text className="chatview__inviteResponded">{t('chatview.responded')}</Text>
            ) : (
              <View className="chatview__inviteButtons">
                <View
                  className="chatview__inviteBtn chatview__inviteBtn--primary"
                  onClick={() => {
                    void respondToGroupInvite(inviteId, true).catch((err: unknown) => {
                      console.error('respondToGroupInvite failed:', err);
                    });
                  }}
                >
                  <Text className="chatview__inviteBtnText chatview__inviteBtnText--primary">
                    {t('common.accept')}
                  </Text>
                </View>
                <View
                  className="chatview__inviteBtn"
                  onClick={() => {
                    void respondToGroupInvite(inviteId, false).catch((err: unknown) => {
                      console.error('respondToGroupInvite failed:', err);
                    });
                  }}
                >
                  <Text className="chatview__inviteBtnText">{t('common.decline')}</Text>
                </View>
              </View>
            )}
          </View>
        );
      }

      if (item.kind === 'file' && item.fileMeta) {
        const fileMeta = item.fileMeta;
        const isOutgoing = item.fromDid === myDid;
        const { senderDisplayName, senderHandle, senderAvatarUrl } = senderIdentityFor(item);
        return (
          <FileMessageBubble
            fileMeta={fileMeta}
            isOutgoing={isOutgoing}
            senderDisplayName={senderDisplayName}
            senderHandle={senderHandle}
            senderAvatarUrl={senderAvatarUrl}
            reactions={item.reactions}
            currentDid={myDid || undefined}
            onDownload={
              !isOutgoing && fileMeta.downloadStatus === 'pending'
                ? () => {
                    void downloadFile(conversationId, item.id).catch((err: unknown) => {
                      console.error('Download file failed:', err);
                    });
                  }
                : undefined
            }
            onRetry={
              fileMeta.downloadStatus === 'failed'
                ? () => {
                    void downloadFile(conversationId, item.id).catch((err: unknown) => {
                      console.error('Retry download failed:', err);
                    });
                  }
                : undefined
            }
            onRetryUpload={
              fileMeta.uploadStatus === 'failed'
                ? () => {
                    void retryUploadFileMessage(conversationId, item.id).catch((err: unknown) => {
                      console.error('Retry upload failed:', err);
                    });
                  }
                : undefined
            }
            onImagePress={
              fileMeta.localPath
                ? () => {
                    void Taro.navigateTo({
                      url: `/pages/pkg-chat/image-viewer/index?uri=${encodeURIComponent(fileMeta.localPath!)}`,
                    });
                  }
                : undefined
            }
            onVideoPress={
              fileMeta.localPath
                ? () => {
                    void Taro.navigateTo({
                      url: `/pages/pkg-chat/video-viewer/index?uri=${encodeURIComponent(fileMeta.localPath!)}&name=${encodeURIComponent(fileMeta.fileName)}`,
                    });
                  }
                : undefined
            }
            onSave={
              fileMeta.downloadStatus === 'ready' && fileMeta.localPath
                ? () => {
                    void handleSaveFile(item);
                  }
                : undefined
            }
            onReactionPress={canReact ? (emoji) => void handleReact(item, emoji) : undefined}
            onOpenPicker={canReact ? (pos) => handleOpenPicker(item, pos) : undefined}
            onLongPress={
              canReact || !isGroup ? (pos) => handleShowActionMenu(item, pos) : undefined
            }
          />
        );
      }

      const isOutgoing = item.fromDid === myDid;
      const { senderDisplayName, senderHandle, senderAvatarUrl } = senderIdentityFor(item);
      return (
        <MessageBubble
          text={item.plaintext}
          isOutgoing={isOutgoing}
          reactions={item.reactions}
          currentDid={myDid || undefined}
          senderDisplayName={senderDisplayName}
          senderHandle={senderHandle}
          senderAvatarUrl={senderAvatarUrl}
          onReactionPress={canReact ? (emoji) => void handleReact(item, emoji) : undefined}
          onOpenPicker={canReact ? (pos) => handleOpenPicker(item, pos) : undefined}
          onLongPress={
            canReact || !isGroup ? (pos) => handleShowActionMenu(item, pos) : undefined
          }
        />
      );
    },
    [
      myDid,
      t,
      receivedGroupInvites,
      respondToGroupInvite,
      senderIdentityFor,
      canReact,
      handleReact,
      handleOpenPicker,
      handleShowActionMenu,
      handleSaveFile,
      conversationId,
      downloadFile,
      retryUploadFileMessage,
    ],
  );

  // 视觉顺序：旧 → 新（messages 是新 → 旧）
  const displayMessages = useMemo(() => [...messages].reverse(), [messages]);

  const overlayOpen = pickerTarget !== null || actionMenuTarget !== null;
  const groupReadonly = isGroup && (dissolved || removed || left);

  return (
    <View
      className="chatview"
      /* 🔴 键盘顶起方案（0.0.9）：根容器 padding-bottom（普通布局回流），
         绝不能用 transform 平移 composer ——
         聚焦瞬间唯一的状态变更就是键盘高度回调，若它给 textarea 祖先挂
         transform（还带 transition，动画期间原生层逐帧重同步），部分机型上
         同层渲染的 textarea 会被重新挂载/打断 first responder →
         「键盘刚弹起就收起、始终无法拉起输入法」（真机实锤的失焦路径）。
         padding-bottom 是普通回流（等价 adjust-position 但只作用于本容器），
         flex:1 的消息列表自动压缩，composer 自然落到键盘正上方。
         ⚠️ 键盘高度是运行时 px，内联 style 的 px 不会被 Taro 转 rpx，正好。 */
      style={kbHeight > 0 ? `padding-bottom: ${kbHeight}px;` : ''}
    >
      {/* header */}
      <View className="chatview__header">
        <View className="chatview__avatar">
          {isGroup ? (
            <Text className="chatview__avatarText">{(displayName[0] ?? '?').toUpperCase()}</Text>
          ) : friendAvatarUrl && !friendAvatarError ? (
            <Image
              className="chatview__avatarImg"
              src={friendAvatarUrl}
              mode="aspectFill"
              onError={() => setFriendAvatarError(true)}
            />
          ) : (
            <Text className="chatview__avatarText">{(displayName[0] ?? '?').toUpperCase()}</Text>
          )}
        </View>
        <View className="chatview__headerText">
          <Text className="chatview__name" numberOfLines={1}>
            {isGroup ? `${t('common.groupPrefix')}${displayName}` : displayName}
          </Text>
          {isGroup
            ? groupCreatorHandle
              ? <Text className="chatview__handle" numberOfLines={1}>@{groupCreatorHandle}</Text>
              : null
            : friendHandle
              ? <Text className="chatview__handle" numberOfLines={1}>@{friendHandle}</Text>
              : null}
        </View>
        <View className="chatview__menuBtn" onClick={openSettings}>
          <Text className="chatview__menuIcon">⋮</Text>
        </View>
      </View>

      {/* messages：旧 → 新，向上滚动加载更早消息 */}
      <ScrollView
        className="chatview__list"
        scrollY
        scrollIntoView={scrollAnchor}
        onScrollToUpper={loadOlderMessages}
        upperThreshold={120}
      >
        {hasMore && displayMessages.length > 0 ? (
          <View className="chatview__loadMore">
            <Text className="chatview__loadMoreText">
              {loadingMore ? t('common.loading') : ''}
            </Text>
          </View>
        ) : null}

        {/* 锚点 id 挂在页面作用域的包裹 View 上（见 measureAnchor 注释），
            浮层定位与 ScrollView scrollIntoView 都依赖它 */}
        {displayMessages.map((msg) => (
          <View key={msg.id} id={anchorIdOf(msg.id)}>{renderItem(msg)}</View>
        ))}

        {displayMessages.length === 0 ? (
          <View className="chatview__empty">
            <Text className="chatview__hint">{t('chatlist.noMessages')}</Text>
          </View>
        ) : null}
      </ScrollView>

      {isBlocked ? <Text className="chatview__blockedHint">{t('chatview.blockedHint')}</Text> : null}

      {/* composer */}
      {groupReadonly ? (
        <View className="chatview__composer chatview__composer--readonly">
          <Text className="chatview__dissolvedText">
            {dissolved ? t('chatview.dissolved') : removed ? t('chatview.removed') : t('chatview.left')}
          </Text>
        </View>
      ) : (
        <View className="chatview__composer">
          <View className="chatview__attachBtn" onClick={() => void handleAttach()}>
            <Text className="chatview__attachIcon">📄</Text>
          </View>
          <View className="chatview__modeBtn" onClick={toggleVoiceMode}>
            <Text className="chatview__modeIcon">{voiceMode ? '⌨️' : '🎤'}</Text>
          </View>
          {voiceMode ? (
            /* 🔴 按住说话：纯 View + touch 事件（不能用 Button——微信 Button
               有原生 hover/active 态会抢触摸）。短于 500ms 的录音会被丢弃。 */
            <View
              className={`chatview__talkBtn ${isBlocked ? 'chatview__talkBtn--disabled' : ''}`}
              onTouchStart={onVoiceTouchStart}
              onTouchMove={onVoiceTouchMove}
              onTouchEnd={onVoiceTouchEnd}
              onTouchCancel={onVoiceTouchCancel}
            >
              <Text className="chatview__talkBtnText">{t('chatview.holdToTalk')}</Text>
            </View>
          ) : (
          <Textarea
            className="chatview__input"
            /* 🔴 高度必须用**内联 style**：微信原生 textarea 的 UA 默认高度是
               内联样式（约两行），class 里的 height 压不过它。
               🔴 不能用 autoHeight：官方文档明确 auto-height 时 height 失效，
               初始高度永远是 UA 默认的两行 —— 改为手动控高：
               height = 行数×行高(42rpx) + 上下 padding(32rpx)，上限 320rpx。 */
            style={
              (overlayOpen ? 'visibility: hidden;' : '') +
              `height: ${Math.min(Math.max(inputLines, 1) * 42 + 32, 320)}rpx;`
            }
            value={text}
            disabled={isBlocked}
            maxlength={-1}
            /* 关掉 iOS 键盘上方的「完成」工具栏 */
            showConfirmBar={false}
            /* 点击发送按钮等页面区域时不收起键盘 */
            holdKeyboard
            /* 🔴 默认 adjustPosition 会把**整个页面**顶走（看不到在和谁聊、
               聊天记录全部滚出视口）。关闭后由根容器手动
               padding-bottom(键盘高度)（见根 View 注释），composer 随 flex
               布局自然落在键盘正上方，header 纹丝不动 */
            adjustPosition={false}
            onKeyboardHeightChange={(e) => {
              const h = e.detail.height || 0;
              setKbHeight(h);
              if (h > 0 && messagesRef.current.length > 0) {
                // 键盘弹起压缩可视区后滚到最新一条
                setScrollAnchor(anchorIdOf(messagesRef.current[0]!.id));
              }
            }}
            onLineChange={(e) => setInputLines(Math.max(1, e.detail.lineCount || 1))}
            placeholder={t('chatview.typeMessage')}
            placeholderClass="chatview__placeholder"
            onInput={(e) => setText(e.detail.value)}
          />
          )}
          {!voiceMode ? (
            <View
              className={`chatview__sendBtn ${sending || isBlocked || !text.trim() ? 'chatview__sendBtn--disabled' : ''}`}
              onClick={() => void onSend()}
            >
              <Text className="chatview__sendBtnText">{sending ? '…' : t('chatview.send')}</Text>
            </View>
          ) : null}
        </View>
      )}

      {/* 按住说话浮层：正在录音 / 上滑取消态 */}
      {recordingUi ? (
        <View className="chatview__recordOverlay">
          <View className={`chatview__recordPanel ${recordCancelUi ? 'chatview__recordPanel--cancel' : ''}`}>
            <Text className="chatview__recordIcon">{recordCancelUi ? '✕' : '🎤'}</Text>
            <Text className="chatview__recordSeconds">{recordSeconds}″</Text>
            <Text className="chatview__recordHint">
              {recordCancelUi
                ? t('chatview.releaseToCancel')
                : `${t('chatview.slideUpToCancel')} · ${t('chatview.releaseToSend')}`}
            </Text>
          </View>
        </View>
      ) : null}

      <EmojiPicker
        visible={pickerTarget !== null}
        layout={pickerLayout}
        onSelect={(emoji) => {
          if (pickerTarget) void handleReact(pickerTarget, emoji);
        }}
        onClose={() => {
          setPickerTarget(null);
          setPickerLayout(null);
        }}
      />
      <MessageActionMenu
        visible={actionMenuTarget !== null}
        layout={actionMenuLayout}
        isOutgoing={actionMenuTarget ? actionMenuTarget.fromDid === myDid : false}
        // 文件消息不可复制：菜单只留 转发/删除 两项
        showCopy={actionMenuTarget ? actionMenuTarget.kind !== 'file' : true}
        onCopy={() => {
          if (actionMenuTarget) handleCopy(actionMenuTarget);
        }}
        onForward={() => {
          if (actionMenuTarget) handleForward(actionMenuTarget);
        }}
        onDelete={() => {
          if (actionMenuTarget) void handleDeleteMessage(actionMenuTarget);
        }}
        onClose={() => {
          setActionMenuTarget(null);
          setActionMenuLayout(null);
        }}
      />
    </View>
  );
}
