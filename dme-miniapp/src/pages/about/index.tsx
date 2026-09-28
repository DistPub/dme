/**
 * pages/about/index.tsx
 *
 * 对照 dme-client/src/ui/AboutScreen.tsx 原样复刻。
 * 外链在小程序里改为「复制链接到剪贴板」（web 无 iframe 宿主、小程序无 <a>）。
 */

import { View, Text, ScrollView, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { useI18n } from '../../i18n/I18nContext';
import { setClipboard } from '../../platform/clipboard';
import { useWebTitle } from '../../utils/web-title';
import './index.scss';

const GITHUB_URL = 'https://github.com/distpub/dme';
const FATESKY_URL = 'https://app.hukoubook.com/';
const SMITECHOW_URL = 'https://app.hukoubook.com/profile/smitechow.com';

export default function AboutPage(): React.JSX.Element {
  const { t } = useI18n();

  useWebTitle(t('about.title'));

  const copy = async (url: string): Promise<void> => {
    await setClipboard(url);
    await Taro.showToast({ title: t('common.copy'), icon: 'success' });
  };

  return (
    <View className="about">
      <View className="about__header">
        <Button
          className="about__backBtn"
          onClick={async () => {
            await Taro.navigateBack();
          }}
        >
          {t('common.back')}
        </Button>
        <Text className="about__title">{t('about.title')}</Text>
      </View>

      <ScrollView className="about__content" scrollY>
        <Text className="about__body">{t('about.intro')}</Text>
        <Text className="about__body">{t('about.mission')}</Text>

        <Text className="about__hint">{t('about.openSourceHint')}</Text>
        <Text className="about__link" onClick={() => void copy(GITHUB_URL)}>
          {t('about.githubLabel')}
        </Text>

        <Text className="about__body">{t('about.official')}</Text>
        <Text className="about__link" onClick={() => void copy(FATESKY_URL)}>
          {t('about.fateskyLabel')}
        </Text>

        <View className="about__footer">
          <Text className="about__footerText">{t('about.madeWith')}</Text>
          <Text className="about__link" onClick={() => void copy(SMITECHOW_URL)}>
            {t('about.smitechowLabel')}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
