/**
 * pages/pkg-chat/group-settings/index.tsx
 *
 * 对照 dme-client/src/ui/GroupSettingsScreen.tsx 原样复刻。
 *
 * - 成员列表：头像 + 昵称 + @handle + 创建者标记 + [屏蔽/解除] + [移除]（仅创建者）
 * - [邀请新成员] → create-group?groupId=（仅创建者）
 * - [解散群聊]（创建者）/ [离开群聊]（普通成员）
 * - dissolved / removed / left 三种只读态 → 提示 + [删除会话]
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, Button, Image, Input } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';

import { useApp } from '../../../state/AppContext';
import { useI18n } from '../../../i18n/I18nContext';
import { getProfilesCached, resolveHandleCached } from '../../../atproto/profile-cache';
import type { GroupMember } from '../../../protocol/group-message';
import { useWebTitle } from '../../../utils/web-title';
import './index.scss';

interface MemberProfile {
  handle: string;
  displayName: string;
  avatar: string | null;
}

export default function GroupSettingsPage(): React.JSX.Element {
  const { t } = useI18n();
  const router = useRouter();
  const groupId = router.params.groupId ? decodeURIComponent(router.params.groupId) : '';

  const {
    session,
    storage,
    pds,
    chatListVersion,
    blockList,
    removeMemberFromGroup,
    dissolveGroup,
    leaveGroup,
    blockMember,
    unblockMember,
    deleteFriend,
  } = useApp();

  const [groupName, setGroupName] = useState('');
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [memberProfiles, setMemberProfiles] = useState<Record<string, MemberProfile>>({});
  const [dissolved, setDissolved] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [left, setLeft] = useState(false);
  const [loading, setLoading] = useState(true);
  const [blockTarget, setBlockTarget] = useState<
    { did: string; displayName: string; handle: string } | null
  >(null);

  const profileCacheRef = useRef<Record<string, MemberProfile>>({});

  useWebTitle(t('groupsettings.title'));

  const resolveProfiles = useCallback(
    async (dids: string[]): Promise<Record<string, MemberProfile>> => {
      const missing = [...new Set(dids.filter((did) => !profileCacheRef.current[did]))];

      if (missing.length > 0 && pds) {
        try {
          const profiles = await getProfilesCached(pds, missing);
          for (const did of missing) {
            const profile = profiles[did];
            if (!profile) continue;
            profileCacheRef.current[did] = {
              handle: profile.handle || did,
              displayName: profile.displayName ?? '',
              avatar: profile.avatar ?? null,
            };
          }
        } catch (err) {
          console.warn('group-settings: getProfilesCached 失败', err);
        }
      }

      const stillMissing = missing.filter((did) => !profileCacheRef.current[did]);
      if (stillMissing.length > 0) {
        await Promise.all(
          stillMissing.map(async (did) => {
            try {
              const handle = await resolveHandleCached(did);
              profileCacheRef.current[did] = { handle, displayName: '', avatar: null };
            } catch {
              profileCacheRef.current[did] = { handle: did, displayName: '', avatar: null };
            }
          }),
        );
      }

      const result: Record<string, MemberProfile> = {};
      for (const did of dids) {
        if (profileCacheRef.current[did]) result[did] = profileCacheRef.current[did];
      }
      return result;
    },
    [pds],
  );

  useEffect(() => {
    if (!storage || !groupId) return;
    let cancelled = false;

    (async () => {
      const info = await storage.getGroupInfo(groupId);
      if (cancelled) return;
      if (info) {
        setGroupName(info.groupName);
        setMembers([...info.members]);
        setDissolved(info.dissolved ?? false);
        setRemoved(info.removed ?? false);
        setLeft(info.left ?? false);

        const cached: Record<string, MemberProfile> = {};
        for (const m of info.members) {
          const entry = profileCacheRef.current[m.did];
          if (entry) cached[m.did] = entry;
        }
        setMemberProfiles(cached);
      }
      setLoading(false);

      if (!info) return;
      const memberDids = info.members.map((m) => m.did);
      const missing = memberDids.filter((did) => !profileCacheRef.current[did]);
      if (missing.length === 0) return;

      const resolved = await resolveProfiles(memberDids);
      if (!cancelled) setMemberProfiles(resolved);
    })();

    return () => {
      cancelled = true;
    };
  }, [storage, groupId, chatListVersion, resolveProfiles]);

  const isCreator = members.some((m) => m.did === session?.did && m.role === 'creator');

  const confirmBlock = useCallback(async (): Promise<void> => {
    if (blockTarget) {
      await blockMember(blockTarget.did);
    }
    setBlockTarget(null);
  }, [blockTarget, blockMember]);

  if (loading) {
    return (
      <View className="groupsettings groupsettings--center">
        <Text className="groupsettings__status">{t('common.loading')}</Text>
      </View>
    );
  }

  const readOnly = dissolved || removed || left;

  return (
    <View className="groupsettings">
      <View className="groupsettings__header">
        <Button
          className="groupsettings__backBtn"
          onClick={async () => {
            await Taro.navigateBack();
          }}
        >
          {t('common.back')}
        </Button>
        <Text className="groupsettings__title">
          {readOnly ? t('groupsettings.title') : groupName || t('groupsettings.title')}
        </Text>
      </View>

      {readOnly ? (
        <View className="groupsettings__body">
          <Text className="groupsettings__dissolvedHint">
            {dissolved
              ? t('groupsettings.dissolved')
              : removed
                ? t('groupsettings.removed')
                : t('groupsettings.left')}
          </Text>
          <Button
            className="groupsettings__btn"
            onClick={async () => {
              await deleteFriend(groupId);
              await Taro.navigateBack();
            }}
          >
            {t('groupsettings.deleteConversation')}
          </Button>
        </View>
      ) : (
        <View className="groupsettings__body">
          <Text className="groupsettings__sectionLabel">
            {t('groupsettings.members', { n: members.length })}
          </Text>

          <ScrollView className="groupsettings__list" scrollY>
            {members.map((item) => {
              const profile = memberProfiles[item.did];
              const displayName = profile?.displayName || profile?.handle || item.displayName;
              const handle = profile?.handle ?? '';
              const avatarUrl = profile?.avatar ?? null;
              const canAct = item.did !== session?.did;
              const isBlocked = blockList.includes(item.did);
              return (
                <View key={item.did} className="groupsettings__memberRow">
                  {avatarUrl ? (
                    <Image
                      className="groupsettings__memberAvatar"
                      src={avatarUrl}
                      mode="aspectFill"
                    />
                  ) : (
                    <View className="groupsettings__memberAvatar groupsettings__memberAvatar--fallback">
                      <Text className="groupsettings__memberAvatarText">
                        {(displayName || '?').slice(0, 1).toUpperCase()}
                      </Text>
                    </View>
                  )}

                  <View className="groupsettings__memberText">
                    <View className="groupsettings__memberNameRow">
                      <Text className="groupsettings__memberName">{displayName}</Text>
                      {item.role === 'creator' ? (
                        <Text className="groupsettings__creatorTag">{t('common.creatorTag')}</Text>
                      ) : null}
                    </View>
                    {handle ? (
                      <Text className="groupsettings__memberHandle">@{handle}</Text>
                    ) : null}
                  </View>

                  <View className="groupsettings__memberActions">
                    {canAct && !isBlocked ? (
                      <Button
                        className="groupsettings__miniBtn"
                        onClick={() => setBlockTarget({ did: item.did, displayName, handle })}
                      >
                        {t('common.block')}
                      </Button>
                    ) : null}
                    {canAct && isBlocked ? (
                      <Button
                        className="groupsettings__miniBtn"
                        onClick={() => void unblockMember(item.did)}
                      >
                        {t('common.unblock')}
                      </Button>
                    ) : null}
                    {isCreator && item.role !== 'creator' ? (
                      <Button
                        className="groupsettings__miniBtn groupsettings__miniBtn--danger"
                        onClick={() => void removeMemberFromGroup(groupId, item.did)}
                      >
                        {t('common.remove')}
                      </Button>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </ScrollView>

          {isCreator ? (
            <Button
              className="groupsettings__btn groupsettings__btn--primary"
              onClick={async () => {
                await Taro.navigateTo({
                  url: `/pages/pkg-chat/create-group/index?groupId=${encodeURIComponent(groupId)}`,
                });
              }}
            >
              {t('groupsettings.inviteNewMember')}
            </Button>
          ) : null}

          {isCreator ? (
            <Button
              className="groupsettings__btn groupsettings__btn--danger"
              onClick={async () => {
                await dissolveGroup(groupId);
                await Taro.navigateBack();
              }}
            >
              {t('groupsettings.dissolveGroup')}
            </Button>
          ) : (
            <Button
              className="groupsettings__btn groupsettings__btn--danger"
              onClick={async () => {
                await leaveGroup(groupId);
                await Taro.navigateBack();
              }}
            >
              {t('groupsettings.leaveGroup')}
            </Button>
          )}
        </View>
      )}

      {blockTarget ? (
        <>
          <View className="groupsettings__modalMask" onClick={() => setBlockTarget(null)} />
          <View className="groupsettings__modalCard">
            <Text className="groupsettings__modalTitle">{t('groupsettings.blockMember')}</Text>
            <Text className="groupsettings__modalMessage">
              {t('groupsettings.blockModalMessage', {
                name: blockTarget.handle
                  ? blockTarget.handle === blockTarget.displayName
                    ? `@${blockTarget.handle}`
                    : `${blockTarget.displayName}（@${blockTarget.handle}）`
                  : blockTarget.displayName,
              })}
            </Text>
            <View className="groupsettings__modalButtons">
              <Button className="groupsettings__modalBtn" onClick={() => setBlockTarget(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                className="groupsettings__modalBtn groupsettings__modalBtn--primary"
                onClick={() => void confirmBlock()}
              >
                {t('common.block')}
              </Button>
            </View>
          </View>
        </>
      ) : null}
    </View>
  );
}
