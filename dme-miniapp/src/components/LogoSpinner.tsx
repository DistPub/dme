/**
 * components/LogoSpinner.tsx - 品牌加载指示器（logo + 转圈 + 大隐隐于世）。
 *
 * 1:1 复刻 web `dme-client/src/ui/LogoSpinner.tsx`：
 *   - logo 图 192rpx（web 96 逻辑像素）
 *   - 小号 spinner（web ActivityIndicator → CSS 边框旋转圈）
 *   - 「大隐隐于世」五字逐个从右飞入 → 停留 → 向左飞出，5s 循环，
 *     每字错峰 300ms（web Animated 时序等价换算成 CSS keyframes）
 *
 * 🔴 自带全屏 fixed 定位（inset:0 + flex 居中 + 白底）：login 恢复会话、
 * setup 检查密钥/校验通过、chat-list 就绪前的多个过渡页都渲染同一个
 * 组件 —— logo/spinner/文字的屏幕位置**逐像素一致**，页面间 reLaunch
 * 跳转时动画不跳变。调用方无需再套居中容器。
 */

import { View, Image, Text } from '@tarojs/components';

import logoUrl from '../assets/images/logo.png';
import './LogoSpinner.scss';

const SLOGAN_CHARS = ['大', '隐', '隐', '于', '世'];

export function LogoSpinner(): React.JSX.Element {
  return (
    <View className="logospinner">
      <View className="logospinner__inner">
        <Image className="logospinner__logo" src={logoUrl} mode="aspectFit" />
        <View className="logospinner__spinner" />
        <View className="logospinner__slogan">
          {SLOGAN_CHARS.map((c, i) => (
            // 每字独立相位：animation-delay 随 index 错峰（keyframes 周期 5s）
            <Text
              key={`${c}-${i}`}
              className="logospinner__sloganChar"
              style={`animation-delay: ${(i * 0.3).toFixed(1)}s;`}
            >
              {c}
            </Text>
          ))}
        </View>
      </View>
    </View>
  );
}
