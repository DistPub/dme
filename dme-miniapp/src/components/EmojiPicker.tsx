/**
 * components/EmojiPicker.tsx - 表情回应浮层。
 *
 * 对齐 web `dme-client/src/ui/EmojiPicker.tsx`：
 *   - 10 个预设 emoji：👍 ❤️ 😂 😮 😢 🎉 🔥 👏 🙏 💯
 *   - 优先向上展开，否则向下；水平方向夹在屏幕内
 *   - 点背景关闭
 *
 * 小程序差异：web 用 `Dimensions` + `onLayout` 实测面板尺寸；小程序改用
 * **常量面板尺寸**（避免一次额外的 selectorQuery 往返，且尺寸是确定的
 * 5 列 × 2 行布局）。若某机型 emoji 换行成 3 行，仅定位轻微偏移。
 *
 * ⚠️ 见 IMPROVEMENT-PLAN.md §4.2：`<Textarea>` 在部分基础库下是原生组件、
 *    层级最高，会盖住本浮层。ChatView 已按「优先向上展开 + 夹进屏幕」处理；
 *    若真机仍被遮挡，改用 `<CoverView>` 或底部半屏面板。
 */

import { View, Text } from '@tarojs/components';

import { getScreenSize } from '../utils/screen';
import './EmojiPicker.scss';

const PRESET_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👏', '🙏', '💯'];

const GAP = 8;
/** 面板真实像素尺寸（与 EmojiPicker.scss 保持一致）。 */
const PANEL_W = 300;
const PANEL_H = 132;

export interface OverlayLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EmojiPickerProps {
  visible: boolean;
  layout: OverlayLayout | null;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ visible, layout, onSelect, onClose }: EmojiPickerProps): React.JSX.Element {
  if (!visible || !layout) return <></>;

  const screen = getScreenSize();
  const showAbove = layout.y > PANEL_H + GAP + 16;
  const rawTop = showAbove ? layout.y - PANEL_H - GAP : layout.y + layout.height + GAP;
  const top = Math.max(GAP, Math.min(rawTop, screen.height - PANEL_H - GAP));
  // layout.x/y 现在是触点视口坐标（见 utils/screen.posFromEvent）：面板以触点为水平中心
  const left = Math.max(GAP, Math.min(layout.x - PANEL_W / 2, screen.width - PANEL_W - GAP));

  return (
    <View className="emojipicker" catchMove onClick={onClose}>
      <View
        className="emojipicker__panel"
        style={{ top: `${top}px`, left: `${left}px`, width: `${PANEL_W}px`, height: `${PANEL_H}px` }}
        onClick={(e) => e.stopPropagation()}
      >
        {PRESET_EMOJIS.map((emoji) => (
          <View
            key={emoji}
            className="emojipicker__btn"
            onClick={() => {
              onSelect(emoji);
              onClose();
            }}
          >
            <Text className="emojipicker__emoji">{emoji}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
