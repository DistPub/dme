/**
 * ui/DmSettingsScreen.tsx - 1:1 私聊管理页面。
 *
 * 展示对方 profile（头像+昵称+@handle），提供屏蔽/取消屏蔽功能。
 * 屏蔽后该用户的消息不再存储和展示，但不修改 MLS 会话。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { useRoute, useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';

import { theme } from './theme';
import { Button } from './Button';
import { ScreenBackground } from './ScreenBackground';
import { useApp } from '../state/AppContext';
import { getProfileCached, resolveHandleCached } from '../atproto/profile-cache';
import type { RootStackParamList } from '../types/navigation';

type DmSettingsRouteProp = NativeStackScreenProps<RootStackParamList, 'DmSettings'>['route'];
type Navigation = NativeStackNavigationProp<RootStackParamList>;

interface FriendProfile {
  handle: string;
  displayName: string;
  avatar: string | null;
}

export function DmSettingsScreen(): React.JSX.Element {
  const app = useApp();
  const route = useRoute<DmSettingsRouteProp>();
  const navigation = useNavigation<Navigation>();
  const { friendDid } = route.params;

  const [profile, setProfile] = useState<FriendProfile>({
    handle: friendDid,
    displayName: '',
    avatar: null,
  });
  const [loading, setLoading] = useState(true);
  const [blockTarget, setBlockTarget] = useState<
    { did: string; displayName: string; handle: string } | null
  >(null);
  const profileCacheRef = useRef<FriendProfile | null>(null);

  const resolveProfile = useCallback(async (did: string): Promise<FriendProfile> => {
    if (profileCacheRef.current) return profileCacheRef.current;

    let result: FriendProfile = { handle: did, displayName: '', avatar: null };

    if (app.session) {
      try {
        const profile = await getProfileCached(app.session.agent, did);
        if (profile) {
          result = {
            handle: profile.handle ?? did,
            displayName: profile.displayName ?? '',
            avatar: profile.avatar ?? null,
          };
        }
      } catch (err) {
        console.error('resolveProfile: getProfileCached failed', did, err);
      }
    }

    if (!result.displayName && !result.avatar) {
      try {
        const handle = await resolveHandleCached(did);
        if (handle !== did && (!result.handle || result.handle === did)) {
          result = { ...result, handle };
        }
      } catch (err) {
        console.error('resolveProfile: resolveHandleCached failed for', did, err);
      }
    }

    profileCacheRef.current = result;
    return result;
  }, [app.session]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      // 先用缓存同步渲染
      if (profileCacheRef.current) {
        setProfile(profileCacheRef.current);
      }
      setLoading(false);

      (async () => {
        const resolved = await resolveProfile(friendDid);
        if (cancelled) return;
        setProfile(resolved);
      })().catch((err: unknown) =>
        console.error('DmSettingsScreen: load profile failed:', err),
      );

      return () => {
        cancelled = true;
      };
    }, [friendDid, resolveProfile]),
  );

  const isBlocked = app.blockList.includes(friendDid);

  const handleBlock = useCallback((): void => {
    const displayName = profile.displayName || profile.handle || friendDid;
    const handle = profile.handle;
    setBlockTarget({ did: friendDid, displayName, handle });
  }, [friendDid, profile]);

  const confirmBlock = useCallback((): void => {
    if (blockTarget) {
      app.blockMember(blockTarget.did).catch((err: unknown) =>
        console.error('blockMember failed:', err),
      );
    }
    setBlockTarget(null);
  }, [app, blockTarget]);

  const handleUnblock = useCallback((): void => {
    app.unblockMember(friendDid).catch((err: unknown) =>
      console.error('unblockMember failed:', err),
    );
  }, [app, friendDid]);

  const displayName = profile.displayName || profile.handle || friendDid;

  if (loading) {
    return (
      <View style={styles.container}>
        <ScreenBackground />
        <Text style={styles.statusText}>Loading...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScreenBackground />

      <View style={styles.content}>
        <View style={styles.header}>
          <Button
            label="Back"
            onPress={() => navigation.goBack()}
            variant="secondary"
            style={styles.backBtn}
          />
          <Text style={styles.title} numberOfLines={1}>聊天管理</Text>
        </View>

        {/* 对方信息 */}
        <View style={styles.profileSection}>
          {profile.avatar ? (
            <Image
              source={{ uri: profile.avatar }}
              style={styles.avatar}
              contentFit="cover"
              transition={300}
            />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <Text style={styles.avatarFallbackText}>
                {(displayName[0] ?? '?').toUpperCase()}
              </Text>
            </View>
          )}
          <View style={styles.profileText}>
            <Text style={styles.displayName} numberOfLines={1}>
              {displayName}
            </Text>
            {profile.handle ? (
              <Text style={styles.handle} numberOfLines={1}>
                @{profile.handle}
              </Text>
            ) : null}
          </View>
        </View>

        {/* 屏蔽状态提示 */}
        {isBlocked && (
          <Text style={styles.blockedHint}>
            已屏蔽该用户，屏蔽后将不再接收对方的消息。
          </Text>
        )}

        {/* 屏蔽/取消屏蔽按钮 */}
        {isBlocked ? (
          <Button
            label="取消屏蔽"
            onPress={handleUnblock}
            variant="primary"
            style={styles.fullButton}
          />
        ) : (
          <Button
            label="屏蔽用户"
            onPress={handleBlock}
            variant="secondary"
            style={styles.fullButton}
          />
        )}
      </View>

      {/* 屏蔽确认模态 */}
      <Modal
        visible={blockTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setBlockTarget(null)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setBlockTarget(null)}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>屏蔽用户</Text>
            <Text style={styles.modalMessage}>
              屏蔽 {blockTarget?.handle
                ? blockTarget.handle === blockTarget.displayName
                  ? `@${blockTarget.handle}`
                  : `${blockTarget.displayName}（@${blockTarget.handle}）`
                : blockTarget?.displayName
              }? 屏蔽后将不再接收该用户的消息。
            </Text>
            <View style={styles.modalButtons}>
              <Button
                label="取消"
                onPress={() => setBlockTarget(null)}
                variant="secondary"
                style={styles.modalBtn}
              />
              <Button
                label="屏蔽"
                onPress={confirmBlock}
                variant="primary"
                style={styles.modalBtn}
              />
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
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
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: theme.spacing.md,
  },
  backBtn: {
    width: 60,
    height: 40,
  },
  title: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: theme.typography.heading,
    fontWeight: '700',
    marginLeft: theme.spacing.sm,
  },
  profileSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    marginBottom: theme.spacing.md,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    overflow: 'hidden',
  },
  avatarFallback: {
    backgroundColor: theme.colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarFallbackText: {
    color: '#FFFFFF',
    fontSize: theme.typography.heading,
    fontWeight: '700',
  },
  profileText: {
    flex: 1,
  },
  displayName: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    fontWeight: '600',
  },
  handle: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.small,
    marginTop: 2,
  },
  blockedHint: {
    color: theme.colors.error,
    fontSize: theme.typography.caption,
    marginBottom: theme.spacing.md,
  },
  fullButton: {
    width: '100%',
    height: 48,
    marginBottom: theme.spacing.sm,
  },
  statusText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.body,
    textAlign: 'center',
    marginTop: theme.spacing.xl,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.lg,
    width: '80%',
    maxWidth: 320,
  },
  modalTitle: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    fontWeight: '700',
    marginBottom: theme.spacing.sm,
  },
  modalMessage: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
    marginBottom: theme.spacing.md,
    lineHeight: 20,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  modalBtn: {
    flex: 1,
    height: 40,
  },
});
