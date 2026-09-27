/**
 * ui/AboutScreen.tsx - 关于页面。
 *
 * 直接展示客户端介绍与使命、GitHub 开源地址、fatesky 官方私信声明，
 * 底部署名 made with 💖 by @smitechow.com。
 * GitHub / fatesky / @smitechow.com 三处可点击外链：
 * Web 走 window.open（新标签页），Native 走 Linking.openURL（系统浏览器）。
 */

import React from 'react';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { theme } from './theme';
import { Button } from './Button';
import { ScreenBackground } from './ScreenBackground';
import type { RootStackParamList } from '../types/navigation';
import { useI18n } from '../i18n/I18nContext';

type Navigation = NativeStackNavigationProp<RootStackParamList>;

const GITHUB_URL = 'https://github.com/distpub/dme';
const FATESKY_URL = 'https://app.hukoubook.com/';
const SMITECHOW_URL = 'https://app.hukoubook.com/profile/smitechow.com';

function openUrl(url: string): void {
  if (Platform.OS === 'web') {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  void Linking.openURL(url).catch((err) => {
    console.error('AboutScreen: failed to open', url, err);
  });
}

export function AboutScreen(): React.JSX.Element {
  const navigation = useNavigation<Navigation>();
  const { t } = useI18n();

  return (
    <View style={styles.container}>
      <ScreenBackground />

      <View style={styles.header}>
        <Button
          label={t('common.back')}
          onPress={() => navigation.goBack()}
          variant="secondary"
          style={styles.backButton}
        />
        <Text style={styles.headerTitle}>{t('about.title')}</Text>
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
        <Text style={styles.body}>{t('about.intro')}</Text>
        <Text style={styles.body}>{t('about.mission')}</Text>

        <Text style={styles.hint}>{t('about.openSourceHint')}</Text>
        <Pressable onPress={() => openUrl(GITHUB_URL)}>
          <Text style={styles.link}>{t('about.githubLabel')}</Text>
        </Pressable>

        <Text style={styles.body}>{t('about.official')}</Text>
        <Pressable onPress={() => openUrl(FATESKY_URL)}>
          <Text style={styles.link}>{t('about.fateskyLabel')}</Text>
        </Pressable>

        <View style={styles.footer}>
          <Text style={styles.footerText}>{t('about.madeWith')}</Text>
          <Pressable onPress={() => openUrl(SMITECHOW_URL)}>
            <Text style={styles.link}>{t('about.smitechowLabel')}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flex: 1,
  },
  contentInner: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.xl,
    gap: theme.spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.lg,
    paddingBottom: theme.spacing.sm,
    gap: theme.spacing.md,
  },
  backButton: {
    width: 96,
    height: 40,
  },
  headerTitle: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: theme.typography.heading,
    fontWeight: '700',
  },
  body: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    lineHeight: 22,
  },
  sectionTitle: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.heading,
    fontWeight: '700',
    marginTop: theme.spacing.md,
  },
  hint: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
  },
  link: {
    color: theme.colors.accent,
    fontSize: theme.typography.body,
    textDecorationLine: 'underline',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.xl,
  },
  footerText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
  },
});