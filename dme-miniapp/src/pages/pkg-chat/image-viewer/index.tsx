/**
 * pages/pkg-chat/image-viewer/index.tsx
 *
 * 对照 dme-client/src/ui/ImageViewerScreen.tsx：黑底全屏 + 点击关闭。
 *
 * 入参：uri（本地临时文件路径或 blob URL）、name（可选，保存时的文件名提示）。
 * 小程序侧增加 [保存到相册]（web 端用 a[download]，小程序走 saveImageToPhotosAlbum）。
 */

import { View, Text, Button, Image } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';

import { useI18n } from '../../../i18n/I18nContext';
import './index.scss';

export default function ImageViewerPage(): React.JSX.Element {
  const { t } = useI18n();
  const router = useRouter();
  const uri = router.params.uri ? decodeURIComponent(router.params.uri) : '';

  const saveToAlbum = async (): Promise<void> => {
    if (!uri) return;
    try {
      await Taro.saveImageToPhotosAlbum({ filePath: uri });
      await Taro.showToast({ title: t('videoviewer.download'), icon: 'success' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 授权被拒 → 引导去设置页打开相册权限
      if (msg.includes('auth deny') || msg.includes('authorize')) {
        const res = await Taro.showModal({
          title: t('videoviewer.download'),
          content: msg,
          confirmText: t('common.confirm'),
          cancelText: t('common.cancel'),
        });
        if (res.confirm) await Taro.openSetting();
        return;
      }
      await Taro.showToast({ title: msg, icon: 'none' });
    }
  };

  return (
    <View className="imgviewer" onClick={async () => { await Taro.navigateBack(); }}>
      {uri ? (
        <Image
          className="imgviewer__image"
          src={uri}
          mode="aspectFit"
          onClick={(e) => {
            // 阻止冒泡到外层（点图片本体也关闭，与 web「点击任意处关闭」一致）
            e.stopPropagation?.();
          }}
        />
      ) : (
        <Text className="imgviewer__hint">{t('imageviewer.title')}</Text>
      )}

      <View className="imgviewer__toolbar">
        <Button
          className="imgviewer__btn"
          onClick={(e) => {
            e.stopPropagation?.();
            void saveToAlbum();
          }}
        >
          {t('videoviewer.download')}
        </Button>
      </View>
    </View>
  );
}
