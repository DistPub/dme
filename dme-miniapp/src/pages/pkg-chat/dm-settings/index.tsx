/**
 * pages/pkg-chat/dm-settings/index.tsx
 *
 * 对照 dme-client/src/ui/DmSettingsScreen.tsx 原样复刻。
 * 对方资料卡（头像 + 昵称 + @handle）+ [屏蔽]/[取消屏蔽]（屏蔽带确认弹窗）。
 * 屏蔽不修改 MLS 会话，只在本端过滤消息。
 */

import { useCallback, useRef, useState } from 'react';
import { View, Text, Button, Image } from '@tarojs/components';
import Taro, { useRouter, useDidShow } from '@tarojs/taro';

import { useApp } from '../../../state/AppContext';
import { useI18n } from '../../../i18n/I18nContext';
import { getProfileCached, resolveHandleCached } from '../../../atproto/profile-cache';
import { useWebTitle } from '../../../utils/web-title';
import './index.scss';

interface FriendProfile {
  handle: string;
  displayName: string;
  avatar: string | null;
}

export default function DmSettingsPage(): React.JSX.Element {
  const { t } = useI18n();
  const router = useRouter();
  const friendDid = router.params.friendDid ? decodeURIComponent(router.params.friendDid) : '';

  const { session, pds, blockList, blockMember, unblockMember } = useApp();

  const [profile, setProfile] = useState<FriendProfile>({
    handle: friendDid,
    displayName: '',
    avatar: null,
  });
  const [blockTarget, setBlockTarget] = useState<
    { did: string; displayName: string; handle: string } | null
  >(null);
  const profileCacheRef = useRef<FriendProfile | null>(null);

  useWebTitle(profile.displayName || profile.handle || t('dmsettings.title'));

  const resolveProfile = useCallback(
    async (did: string): Promise<FriendProfile> => {
      if (profileCacheRef.current) return profileCacheRef.current;

      let result: FriendProfile = { handle: did, displayName: '', avatar: null };

      if (pds) {
        try {
          const p = await getProfileCached(pds, did);
          if (p) {
            result = {
              handle: p.handle || did,
              displayName: p.displayName ?? '',
              avatar: p.avatar ?? null,
            };
          }
        } catch (err) {
          console.warn('dm-settings: getProfileCached 失败', did, err);
        }
      }

      if (!result.displayName && !result.avatar) {
        try {
          const handle = await resolveHandleCached(did);
          if (handle !== did && (!result.handle || result.handle === did)) {
            result = { ...result, handle };
          }
        } catch (err) {
          console.warn('dm-settings: resolveHandleCached 失败', did, err);
        }
      }

      profileCacheRef.current = result;
      return result;
    },
    [pds],
  );

  useDidShow(
    useCallback((): void => {
      if (profileCacheRef.current) setProfile(profileCacheRef.current);

      void (async () => {
        const resolved = await resolveProfile(friendDid);
        setProfile(resolved);
      })();
    }, [friendDid, resolveProfile]),
  );

  const isBlocked = blockList.includes(friendDid);
  const displayName = profile.displayName || profile.handle || friendDid;

  const onToggleBlock = useCallback((): void => {
    if (isBlocked) {
      void unblockMember(friendDid);
      return;
    }
    setBlockTarget({ did: friendDid, displayName, handle: profile.handle });
  }, [isBlocked, unblockMember, friendDid, displayName, profile.handle]);

  const confirmBlock = useCallback(async (): Promise<void> => {
    if (blockTarget) await blockMember(blockTarget.did);
    setBlockTarget(null);
  }, [blockTarget, blockMember]);

  return (
    <View className="dmsettings">
      <View className="dmsettings__card">
        {profile.avatar ? (
          <Image className="dmsettings__avatar" src={profile.avatar} mode="aspectFill" />
        ) : (
          <View className="dmsettings__avatar dmsettings__avatar--fallback">
            <Text className="dmsettings__avatarText">
              {(displayName || '?').slice(0, 1).toUpperCase()}
            </Text>
          </View>
        )}
        <Text className="dmsettings__name">{displayName}</Text>
        {profile.handle ? (
          <Text className="dmsettings__handle">@{profile.handle}</Text>
        ) : null}
      </View>

      {isBlocked ? (
        <Text className="dmsettings__blockedHint">{t('dmsettings.blockedHint')}</Text>
      ) : null}

      <View className="dmsettings__actions">
        <Button
          className={`dmsettings__btn ${isBlocked ? '' : 'dmsettings__btn--danger'}`}
          onClick={onToggleBlock}
        >
          {isBlocked ? t('dmsettings.unblockUser') : t('dmsettings.blockUser')}
        </Button>
        <Button
          className="dmsettings__btn"
          onClick={async () => {
            await Taro.navigateBack();
          }}
        >
          {t('common.back')}
        </Button>
      </View>

      {blockTarget ? (
        <>
          <View className="dmsettings__modalMask" onClick={() => setBlockTarget(null)} />
          <View className="dmsettings__modalCard">
            <Text className="dmsettings__modalTitle">{t('dmsettings.blockUser')}</Text>
            <Text className="dmsettings__modalMessage">
              {t('dmsettings.blockModalMessage', {
                name: blockTarget.handle
                  ? blockTarget.handle === blockTarget.displayName
                    ? `@${blockTarget.handle}`
                    : `${blockTarget.displayName}（@${blockTarget.handle}）`
                  : blockTarget.displayName,
              })}
            </Text>
            <View className="dmsettings__modalButtons">
              <Button className="dmsettings__modalBtn" onClick={() => setBlockTarget(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                className="dmsettings__modalBtn dmsettings__modalBtn--danger"
                onClick={() => void confirmBlock()}
              >
                {t('dmsettings.blockUser')}
              </Button>
            </View>
          </View>
        </>
      ) : null}
    </View>
  );
}
