/**
 * components/MessageBubble.tsx - 文本消息气泡。
 *
 * 对齐 web `dme-client/src/ui/MessageBubble.tsx`：
 *   - 左右对齐（isOutgoing）+ 最大宽度限制
 *   - 群聊模式下显示发送者头像 / 昵称 / @handle（1:1 时不显示）
 *   - reactions 表情 pill（点 = 加/取消回应）
 *   - 气泡两侧的 😀 按钮 → 打开 EmojiPicker
 *   - 长按气泡 → 打开 MessageActionMenu
 *
 * 小程序差异（有意为之，见 IMPROVEMENT-PLAN.md §4.2）：
 *   - web 用 `measureInWindow` 把气泡坐标回传给页面；小程序改成页面侧的
 *     `createSelectorQuery().boundingClientRect()`，所以这里只暴露 `anchorId`
 *     （由 ChatView 生成 `m-<msgId>`）与无参回调。
 *   - web 把 EmojiPicker 锚定在 😀 按钮上；小程序统一锚定在气泡上（同一行内，
 *     视觉差异可忽略，换取只维护一个锚点）。
 */

import { useEffect, useMemo, useState } from 'react';
import { View, Text, Image } from '@tarojs/components';

import type { Reaction } from '../storage/db';
import { posFromEvent, type TapPos } from '../utils/screen';
import './MessageBubble.scss';

export interface MessageBubbleProps {
  text: string;
  isOutgoing: boolean;
  senderDisplayName?: string;
  senderHandle?: string;
  /**
   * `undefined` = 不显示头像（1:1 会话）；
   * `null` = 显示首字母回退头像；
   * 字符串 = 图片 URL。
   */
  senderAvatarUrl?: string | null;
  reactions?: Reaction[];
  currentDid?: string;
  onReactionPress?: (emoji: string) => void;
  /** 打开表情选择浮层，参数为触点视口坐标（浮层定位用）。 */
  onOpenPicker?: (pos: TapPos) => void;
  /** 长按气泡，参数为触点视口坐标。 */
  onLongPress?: (pos: TapPos) => void;
}

export function MessageBubble({
  text,
  isOutgoing,
  senderDisplayName,
  senderHandle,
  senderAvatarUrl,
  reactions,
  currentDid,
  onReactionPress,
  onOpenPicker,
  onLongPress,
}: MessageBubbleProps): React.JSX.Element {
  const [avatarError, setAvatarError] = useState(false);

  useEffect(() => {
    setAvatarError(false);
  }, [senderAvatarUrl]);

  /** 按 emoji 归并：count 一致、是否包含自己。 */
  const grouped = useMemo(() => {
    const map = new Map<string, { emoji: string; count: number; includesMe: boolean }>();
    for (const r of reactions ?? []) {
      const entry = map.get(r.emoji) ?? { emoji: r.emoji, count: 0, includesMe: false };
      entry.count += 1;
      if (r.did === currentDid) entry.includesMe = true;
      map.set(r.emoji, entry);
    }
    return [...map.values()];
  }, [reactions, currentDid]);

  const renderAvatar = (): React.JSX.Element | null => {
    if (senderAvatarUrl === undefined) return null;
    const fallbackLetter = (senderDisplayName?.[0] ?? '?').toUpperCase();
    return (
      <View className="msgbubble__avatarWrap">
        {senderAvatarUrl && !avatarError ? (
          <Image
            className="msgbubble__avatarImg"
            src={senderAvatarUrl}
            mode="aspectFill"
            onError={() => setAvatarError(true)}
          />
        ) : (
          <Text className="msgbubble__avatarLetter">{fallbackLetter}</Text>
        )}
      </View>
    );
  };

  const renderEmojiBtn = (): React.JSX.Element | null => {
    if (!onOpenPicker) return null;
    return (
      <View className="msgbubble__emojiBtn" onClick={(e) => onOpenPicker(posFromEvent(e))}>
        <Text className="msgbubble__emojiIcon">😀</Text>
      </View>
    );
  };

  return (
    <View className={`msgbubble ${isOutgoing ? 'msgbubble--out' : 'msgbubble--in'}`}>
      {!isOutgoing ? renderAvatar() : null}

      <View className="msgbubble__col">
        {senderDisplayName && !isOutgoing ? (
          <View className="msgbubble__senderWrap">
            <Text className="msgbubble__sender">{senderDisplayName}</Text>
            {senderHandle ? <Text className="msgbubble__handle">@{senderHandle}</Text> : null}
          </View>
        ) : null}

        <View className={`msgbubble__row ${isOutgoing ? 'msgbubble__row--out' : 'msgbubble__row--in'}`}>
          {isOutgoing ? renderEmojiBtn() : null}
          <View
            className={`msgbubble__bubble ${isOutgoing ? 'msgbubble__bubble--out' : 'msgbubble__bubble--in'}`}
            onLongPress={onLongPress ? (e) => onLongPress(posFromEvent(e)) : undefined}
          >
            <Text className="msgbubble__text">{text}</Text>
          </View>
          {!isOutgoing ? renderEmojiBtn() : null}
        </View>

        {grouped.length > 0 ? (
          <View
            className={`msgbubble__reactions ${isOutgoing ? 'msgbubble__reactions--out' : 'msgbubble__reactions--in'}`}
          >
            {grouped.map((entry) => (
              <View
                key={entry.emoji}
                className={`msgbubble__pill ${entry.includesMe ? 'msgbubble__pill--active' : ''}`}
                onClick={onReactionPress ? () => onReactionPress(entry.emoji) : undefined}
              >
                <Text className="msgbubble__pillEmoji">{entry.emoji}</Text>
                {entry.count > 1 ? <Text className="msgbubble__pillCount">{entry.count}</Text> : null}
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {isOutgoing ? renderAvatar() : null}
    </View>
  );
}
