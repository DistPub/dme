/**
 * components/MessageActionMenu.tsx - 消息长按操作菜单（复制 / 转发 / 删除）。
 *
 * 对齐 web `dme-client/src/ui/MessageActionMenu.tsx`：
 *   - 默认三项：复制 / 转发 / 删除（删除为红字）
 *   - 优先向上展开，否则向下；水平方向：自己发的靠气泡右缘对齐，对方发的靠左缘
 *   - 点背景关闭
 *
 * 小程序差异：
 *   - 用**常量面板尺寸**替代 web 的 onLayout 实测（尺寸确定，省一次异步往返）
 *   - 文件消息长按场景 showCopy=false：只渲染 转发 / 删除 两项，
 *     面板高度按两项计算（见 PANEL_H_* 常量，与 .scss 注释保持同步）
 */

import { View, Text } from '@tarojs/components';

import { useI18n } from '../i18n/I18nContext';
import { getScreenSize } from '../utils/screen';
import type { OverlayLayout } from './EmojiPicker';
import './MessageActionMenu.scss';

const GAP = 8;
/** 面板真实像素宽度（与 MessageActionMenu.scss 保持一致）。 */
const PANEL_W = 150;
/** 三项面板真实高度：92px CSS（46px 真实）× 3 + 上下 padding 16px = 146px。 */
const PANEL_H_FULL = 146;
/** 两项面板（无复制）真实高度：46 × 2 + 16 = 100px。 */
const PANEL_H_NO_COPY = 100;

export interface MessageActionMenuProps {
  visible: boolean;
  layout: OverlayLayout | null;
  isOutgoing: boolean;
  /** false = 文件消息等不可复制场景：隐藏「复制」，面板同步变矮。默认 true。 */
  showCopy?: boolean;
  onCopy: () => void;
  onForward: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function MessageActionMenu({
  visible,
  layout,
  isOutgoing,
  showCopy = true,
  onCopy,
  onForward,
  onDelete,
  onClose,
}: MessageActionMenuProps): React.JSX.Element {
  const { t } = useI18n();

  if (!visible || !layout) return <></>;

  const screen = getScreenSize();
  const panelH = showCopy ? PANEL_H_FULL : PANEL_H_NO_COPY;
  const showAbove = layout.y > panelH + GAP + 16;
  const rawTop = showAbove ? layout.y - panelH - GAP : layout.y + layout.height + GAP;
  const top = Math.max(GAP, Math.min(rawTop, screen.height - panelH - GAP));
  // layout.x/y 是长按触点视口坐标：自己发的菜单往触点左侧展开，对方的往右侧
  const rawLeft = isOutgoing ? layout.x - PANEL_W : layout.x;
  const left = Math.max(GAP, Math.min(rawLeft, screen.width - PANEL_W - GAP));

  const handlePress = (action: () => void): void => {
    action();
    onClose();
  };

  return (
    <View className="msgmenu" catchMove onClick={onClose}>
      <View
        className="msgmenu__panel"
        style={{ top: `${top}px`, left: `${left}px`, width: `${PANEL_W}px` }}
        onClick={(e) => e.stopPropagation()}
      >
        {showCopy ? (
          <>
            <View className="msgmenu__item" onClick={() => handlePress(onCopy)}>
              <Text className="msgmenu__itemText">{t('menu.copy')}</Text>
            </View>
            <View className="msgmenu__divider" />
          </>
        ) : null}
        <View className="msgmenu__item" onClick={() => handlePress(onForward)}>
          <Text className="msgmenu__itemText">{t('menu.forward')}</Text>
        </View>
        <View className="msgmenu__divider" />
        <View className="msgmenu__item" onClick={() => handlePress(onDelete)}>
          <Text className="msgmenu__itemText msgmenu__itemText--delete">{t('menu.delete')}</Text>
        </View>
      </View>
    </View>
  );
}
