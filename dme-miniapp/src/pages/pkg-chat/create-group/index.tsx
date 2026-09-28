/**
 * pages/pkg-chat/create-group/index.tsx
 *
 * 对照 dme-client/src/ui/CreateGroupScreen.tsx 原样复刻。
 *
 * 两种模式：
 *   - 新建群（无 groupId 参数）：输入群名 + 多选 1:1 好友 → sendGroupInvites
 *   - 给已有群追加成员（带 groupId 参数）：仅多选非成员好友 → 循环 addMemberToGroup
 *
 * 好友候选 = listGroups() 里 did: 开头且不在任何 groupInfo 中的会话（即 1:1 好友）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, Button, Input, Image } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';

import { useApp } from '../../../state/AppContext';
import { useI18n } from '../../../i18n/I18nContext';
import { getProfilesCached, resolveHandleCached } from '../../../atproto/profile-cache';
import { useWebTitle } from '../../../utils/web-title';
import './index.scss';

type Phase = 'select' | 'sending' | 'done';

interface FriendRow {
  did: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  selected: boolean;
}

interface ProfileEntry {
  handle: string;
  displayName: string;
  avatar: string | null;
}

export default function CreateGroupPage(): React.JSX.Element {
  const { t } = useI18n();
  const router = useRouter();
  const existingGroupId = router.params.groupId
    ? decodeURIComponent(router.params.groupId)
    : undefined;

  const { storage, pds, addMemberToGroup, sendGroupInvites } = useApp();

  const [groupName, setGroupName] = useState('');
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [phase, setPhase] = useState<Phase>('select');
  const [errorMsg, setErrorMsg] = useState('');
  const profileCacheRef = useRef<Record<string, ProfileEntry>>({});

  useWebTitle(existingGroupId ? t('creategroup.inviteMembers') : t('creategroup.create'));

  const resolveProfiles = useCallback(
    async (dids: string[]): Promise<Record<string, ProfileEntry>> => {
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
          console.warn('create-group: getProfilesCached 失败', err);
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

      const result: Record<string, ProfileEntry> = {};
      for (const did of dids) {
        if (profileCacheRef.current[did]) result[did] = profileCacheRef.current[did];
      }
      return result;
    },
    [pds],
  );

  useEffect(() => {
    if (!storage) return;
    let cancelled = false;

    (async () => {
      const allGroups = await storage.listGroups();
      const infos = await storage.listGroupInfos();

      const existingMemberDids = new Set<string>();
      if (existingGroupId) {
        const info = infos.find((g) => g.groupId === existingGroupId);
        if (info) {
          setGroupName(info.groupName);
          info.members.forEach((m) => existingMemberDids.add(m.did));
        }
      }

      const groupIdSet = new Set(infos.map((g) => g.groupId));
      const friendDids = allGroups.filter(
        (id) => !groupIdSet.has(id) && id.startsWith('did:') && !existingMemberDids.has(id),
      );

      const rows: FriendRow[] = friendDids.map((did) => {
        const cached = profileCacheRef.current[did];
        return {
          did,
          handle: cached?.handle ?? did,
          displayName: cached?.displayName || cached?.handle || did,
          avatarUrl: cached?.avatar ?? null,
          selected: false,
        };
      });
      if (!cancelled) setFriends(rows);

      const missing = friendDids.filter((did) => !profileCacheRef.current[did]);
      if (missing.length === 0) return;

      const resolved = await resolveProfiles(friendDids);
      if (cancelled) return;
      setFriends((prev) =>
        prev.map((row) => {
          const profile = resolved[row.did];
          if (!profile) return row;
          return {
            ...row,
            handle: profile.handle ?? row.handle,
            displayName: profile.displayName || profile.handle || row.displayName,
            avatarUrl: profile.avatar ?? row.avatarUrl,
          };
        }),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [storage, existingGroupId, resolveProfiles]);

  const toggleFriend = useCallback((did: string): void => {
    setFriends((prev) =>
      prev.map((f) => (f.did === did ? { ...f, selected: !f.selected } : f)),
    );
  }, []);

  const selectedCount = friends.filter((f) => f.selected).length;

  const onSubmit = useCallback(async (): Promise<void> => {
    const selected = friends.filter((f) => f.selected);
    if (selected.length === 0) return;
    if (!existingGroupId && !groupName.trim()) return;

    setPhase('sending');
    setErrorMsg('');

    try {
      if (existingGroupId) {
        for (const friend of selected) {
          await addMemberToGroup(existingGroupId, friend.did);
        }
      } else {
        await sendGroupInvites(
          groupName.trim(),
          selected.map((f) => f.did),
        );
      }
      setPhase('done');
      await Taro.showToast({ title: t('creategroup.sent'), icon: 'success' });
      setTimeout(() => void Taro.navigateBack(), 1200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('creategroup.failed');
      setErrorMsg(msg);
      setPhase('select');
      await Taro.showToast({ title: msg, icon: 'none' });
    }
  }, [friends, existingGroupId, groupName, addMemberToGroup, sendGroupInvites, t]);

  const canSubmit = existingGroupId
    ? selectedCount > 0
    : groupName.trim().length > 0 && selectedCount > 0;

  if (phase !== 'select') {
    return (
      <View className="creategroup__status">
        <Text className="creategroup__statusText">
          {phase === 'sending' ? t('creategroup.sending') : t('creategroup.sent')}
        </Text>
      </View>
    );
  }

  return (
    <View className="creategroup">
      <Text className="creategroup__title">
        {existingGroupId ? t('creategroup.inviteMembers') : t('creategroup.create')}
      </Text>

      {!existingGroupId ? (
        <Input
          className="creategroup__input"
          value={groupName}
          placeholder={t('creategroup.groupNamePlaceholder')}
          onInput={(e) => setGroupName(e.detail.value)}
        />
      ) : null}

      <Text className="creategroup__sectionLabel">
        {t('creategroup.selectFriends', { n: selectedCount })}
      </Text>

      <ScrollView className="creategroup__list" scrollY>
        {friends.length === 0 ? (
          <Text className="creategroup__empty">{t('creategroup.noFriends')}</Text>
        ) : (
          friends.map((item) => (
            <View
              key={item.did}
              className={`creategroup__friendRow ${item.selected ? 'creategroup__friendRow--selected' : ''}`}
              onClick={() => toggleFriend(item.did)}
            >
              {item.avatarUrl ? (
                <Image className="creategroup__friendAvatar" src={item.avatarUrl} mode="aspectFill" />
              ) : (
                <View className="creategroup__friendAvatar creategroup__friendAvatar--fallback">
                  <Text className="creategroup__friendAvatarText">
                    {(item.displayName || '?').slice(0, 1).toUpperCase()}
                  </Text>
                </View>
              )}
              <View className="creategroup__friendText">
                <Text className="creategroup__friendName">{item.displayName}</Text>
                {item.handle ? (
                  <Text className="creategroup__friendHandle">@{item.handle}</Text>
                ) : null}
              </View>
              <Text
                className={`creategroup__check ${item.selected ? 'creategroup__check--active' : ''}`}
              >
                {item.selected ? '✓' : '○'}
              </Text>
            </View>
          ))
        )}
      </ScrollView>

      {errorMsg ? <Text className="creategroup__error">{errorMsg}</Text> : null}

      <Button
        className="creategroup__btn creategroup__btn--primary"
        disabled={!canSubmit}
        onClick={() => void onSubmit()}
      >
        {t('creategroup.sendInvites', { n: selectedCount })}
      </Button>
      <Button
        className="creategroup__btn"
        onClick={async () => {
          await Taro.navigateBack();
        }}
      >
        {t('common.cancel')}
      </Button>
    </View>
  );
}
