/**
 * pages/pkg-chat/video-viewer/index.tsx
 *
 * 对照 dme-client/src/ui/VideoViewerScreen.tsx：全屏播放 + [下载]。
 * 小程序用 <Video> 组件（自带 controls），[下载] 走 saveVideoToPhotosAlbum。
 */

import { useState } from 'react';
import { View, Text, Button, Video } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';

import { useI18n } from '../../../i18n/I18nContext';
import { useWebTitle } from '../../../utils/web-title';
import './index.scss';

export default function VideoViewerPage(): React.JSX.Element {
  const { t } = useI18n();
  const router = useRouter();
  const uri = router.params.uri ? decodeURIComponent(router.params.uri) : '';
  const title = router.params.name ? decodeURIComponent(router.params.name) : t('videoviewer.title');

  const [error, setError] = useState<string | null>(null);

  useWebTitle(title);

  const download = async (): Promise<void> => {
    if (!uri) return;
    try {
      await Taro.saveVideoToPhotosAlbum({ filePath: uri });
      await Taro.showToast({ title: t('videoviewer.download'), icon: 'success' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
      setError(msg);
    }
  };

  return (
    <View className="videoviewer">
      {uri ? (
        <Video
          className="videoviewer__video"
          src={uri}
          controls
          autoplay
          showFullscreenBtn
          onError={(e) => {
            const detail = e.detail as { errMsg?: string } | undefined;
            setError(detail?.errMsg ?? t('videoviewer.unsupported'));
          }}
        />
      ) : (
        <Text className="videoviewer__hint">{t('videoviewer.unsupported')}</Text>
      )}

      {error ? <Text className="videoviewer__error">{error}</Text> : null}

      <View className="videoviewer__toolbar">
        <Button className="videoviewer__btn" onClick={() => void download()}>
          {t('videoviewer.download')}
        </Button>
        <Button
          className="videoviewer__btn"
          onClick={async () => {
            await Taro.navigateBack();
          }}
        >
          {t('common.back')}
        </Button>
      </View>
    </View>
  );
}
