/**
 * pages/pkg-chat/qr-display/index.tsx - 邀请流程（Alice 侧）。
 *
 * 与 dme-client/src/ui/QrDisplayScreen.tsx 的 7 阶段状态机**逐阶段对应**：
 *
 *   input          输入 Bob 的 handle
 *   checking       解析 handle → DID，判定 Bob 的 DME 状态
 *   preview        帖子预览（可编辑正文）+ 二维码；[发布] / [分享] / [取消]
 *   already_friend 已是好友 → [去聊天] / [返回]
 *   publishing     发布中（成功后直接返回主页，**无停留页**）
 *   error          出错 → [重试] / [返回]
 *
 * 三种分支（由 checkBobDmeStatus 决定）：
 *   not_registered         → 纯文本帖（不嵌二维码）+ [分享小程序卡片]（落主页）
 *   registered_not_friend  → 生成 QR + 帖子嵌图 + trackInvitePendingWelcome
 *   already_friend         → already_friend 阶段
 *
 * 平台差异（相对 web）：
 *   - `agent.com.atproto.identity.resolveHandle` → `pds.resolveHandle`
 *   - 二维码预览用 `<Canvas type="2d">` 自绘（web 用 SVG data URI）
 *   - 发帖用 `createDmeInvitePost(pds, …)`（web 传 `agent`）
 *
 * 【增强点（用户确认，不替代 web 原路径）】
 *   preview 阶段：registered_not_friend 可把二维码图 showShareImageMenu
 *   直享到微信聊天；not_registered 可把小程序卡片（落主页）转发给对方。
 *   发布/确认后直接 navigateBack，不再进「已发布」停留页。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Canvas, Button, Input, ScrollView, Textarea } from '@tarojs/components';
import Taro, { useShareAppMessage } from '@tarojs/taro';

import { useApp } from '../../../state/AppContext';
import { useI18n } from '../../../i18n/I18nContext';
import { useWebTitle } from '../../../utils/web-title';
import {
  checkBobDmeStatus,
  createDmeInvitePost,
  generateInvitePostText,
  generateAddFriendPostText,
  generateQrMatrix,
  generateQrPngBytes,
  paintQrMatrix,
  QR_MODULE_SIZE,
  type BobStatus,
  type CanvasRenderingContext2DLike,
  type QrMatrix,
} from '../../../handshake/invite';
import './index.scss';

/** 状态机阶段（与 web 一一对应）。
 *  ⚠️ 无 'published'：配对开始后直接返回主页（真机反馈：停留页无必要）。 */
type Phase =
  | 'input'
  | 'checking'
  | 'preview'
  | 'already_friend'
  | 'publishing'
  | 'error';

/**
 * 二维码显示边长（**rpx**，设计稿 750 基准）。
 *
 * ⚠️ 用 rpx 而不是 px：`px` 在小程序里是物理 CSS 像素，写 560px 在 375dp 宽的屏上
 *    就是 560/375 ≈ 150% 屏宽 —— 直接顶满甚至溢出。**rpx 才会按屏宽等比缩放**
 *    （750rpx = 整屏宽），所以显示尺寸一律用 rpx。
 *
 * 取 480rpx ≈ 屏宽的 64%：留出两侧边距后视觉上是一个舒服的方形二维码，
 * 既不会占满屏、也足够大让摄像头扫得清。
 *
 * ⚠️ canvas 的**绘制分辨率**（node.width/height）用 px 算，**显示尺寸**用 rpx ——
 *    两者是不同的量，混用就会出现"太大/被裁切/被拉扁"，
 *    详见 computeQrLayout 与 index.scss `&__canvas` 的注释。
 */
const QR_DISPLAY_RPX = 480;
/** 二维码画布绘制分辨率上限（px）；超过则按比例缩小模块边长。 */
const QR_DRAW_MAX_PX = 480;
/** 模块边长下取整下限，避免超大码时模块碎到不可辨认。 */
const QR_MIN_MODULE_SIZE = 4;
/** canvas 2d 节点 id。 */
const CANVAS_ID = 'dme-invite-qr';

/**
 * 由矩阵推出「画布绘制边长 + 模块边长（均为 px）」，保证整码完整落在画布内。
 *
 * 注意返回的 `size` 是**绘制分辨率**（喂给 canvas.width/height），
 * 与 CSS 显示尺寸（rpx）是两回事：绘制分辨率可以比显示尺寸大，
 * 这样在高清屏上二维码不会糊 —— 但**宽高必须同值**。
 */
function computeQrLayout(matrix: QrMatrix): { size: number; moduleSize: number } {
  const total = matrix.totalModules;
  // 按绘制上限反推模块边长（向下取整），保证 size <= 上限
  let moduleSize = Math.max(QR_MIN_MODULE_SIZE, Math.floor(QR_DRAW_MAX_PX / total));
  let size = total * moduleSize;
  // 若上限不足以容纳最小模块，则放宽到实际需要的大小
  if (size > QR_DRAW_MAX_PX) {
    moduleSize = Math.max(1, Math.floor(QR_DRAW_MAX_PX / total));
    size = total * moduleSize;
  }
  return { size, moduleSize };
}

export default function QrDisplayPage(): React.JSX.Element {
  const { t, language } = useI18n();
  const { session, storage, pds, generateInviteQr, trackInvitePendingWelcome } = useApp();

  const [handle, setHandle] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [bobStatus, setBobStatus] = useState<BobStatus | null>(null);
  const [bobDid, setBobDid] = useState('');
  const [bobHandle, setBobHandle] = useState('');
  const [postText, setPostText] = useState('');
  const [qrValue, setQrValue] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [matrix, setMatrix] = useState<QrMatrix | null>(null);
  /** 画布边长 + 模块边长（由矩阵动态算出，见 computeQrLayout）。 */
  const [qrLayout, setQrLayout] = useState<{ size: number; moduleSize: number } | null>(null);

  const submittedRef = useRef(false);
  const keyPackageSerializedRef = useRef('');
  const welcomeQueueIdRef = useRef('');

  useWebTitle(t('qrdisplay.title'));

  // ---- 二维码矩阵（纯 JS，等价 web 的 generateQrSvgDataUri 预览） --------
  useEffect(() => {
    if (!qrValue) {
      setMatrix(null);
      setQrLayout(null);
      return;
    }
    try {
      const m = generateQrMatrix(qrValue);
      setMatrix(m);
      setQrLayout(computeQrLayout(m));
    } catch (err) {
      console.error('生成二维码矩阵失败:', err);
      setMatrix(null);
      setQrLayout(null);
    }
  }, [qrValue]);

  // ---- 把矩阵画到 canvas 2d 节点 ----------------------------------------
  useEffect(() => {
    if (!matrix || !qrLayout) return;
    let cancelled = false;

    (async () => {
      try {
        const canvas = await new Promise<{
          width: number;
          height: number;
          getContext(type: string): unknown;
        } | null>((resolve) => {
          Taro.createSelectorQuery()
            .select(`#${CANVAS_ID}`)
            .fields({ node: true, size: true })
            .exec((res) => {
              const first = res?.[0] as
                | { node?: { width: number; height: number; getContext(t: string): unknown } }
                | undefined;
              resolve(first?.node ?? null);
            });
        });
        if (cancelled || !canvas) return;

        // ⚠️ canvas 2d 的绘制分辨率由 node.width/height 决定，必须显式设置为
        //    布局尺寸，否则默认值会把图裁掉（"二维码显示不全"的根因之一）。
        canvas.width = qrLayout.size;
        canvas.height = qrLayout.size;

        const ctx = canvas.getContext('2d') as CanvasRenderingContext2DLike | null;
        if (!ctx) return;
        paintQrMatrix(ctx, matrix, qrLayout.moduleSize);
      } catch (err) {
        console.error('二维码绘制失败:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [matrix, qrLayout]);

  // ---- 步骤 1-3：解析 handle → 判状态 → 生成帖子/二维码 ------------------
  const onCheckBob = useCallback(async (): Promise<void> => {
    const trimmed = handle.trim();
    if (!trimmed || !session || !pds || submittedRef.current) return;
    submittedRef.current = true;
    setPhase('checking');

    try {
      const resolvedDid = await pds.resolveHandle(trimmed);

      if (resolvedDid === session.did) {
        setErrorMsg(t('qrdisplay.cantInviteSelf'));
        setPhase('error');
        return;
      }

      const status = await checkBobDmeStatus(storage, resolvedDid);
      setBobDid(resolvedDid);
      setBobHandle(trimmed);
      setBobStatus(status);

      if (status === 'not_registered') {
        setPostText(generateInvitePostText(trimmed, language));
        setPhase('preview');
      } else if (status === 'registered_not_friend') {
        const { qrString, keyPackageSerialized, welcomeQueueId } =
          await generateInviteQr(resolvedDid);
        setQrValue(qrString);
        keyPackageSerializedRef.current = keyPackageSerialized;
        welcomeQueueIdRef.current = welcomeQueueId;
        setPostText(generateAddFriendPostText(trimmed, language));
        setPhase('preview');
      } else {
        setPhase('already_friend');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('qrdisplay.failedCheck'));
      setPhase('error');
    }
  }, [handle, session, pds, storage, generateInviteQr, language, t]);

  /**
   * 【仅进入配对流程，不发帖】
   *
   * 用于「分享到微信」路径：用户已经把二维码分享出去了 —— 对方拿到的就是
   * 我方公钥包装，**不需要再发一条 Bluesky 邀请帖**。此时「确认」应只做
   * `trackInvitePendingWelcome`（进入 pendingWelcome 等待状态）然后返回。
   *
   * ⚠️ 与 `onPublish()` 的区别：`onPublish` = 发帖 + 配对（预览页「发布到 Bluesky」用）；
   *    本函数 = **只配对**（分享路径用）。不要把两者混在一起，否则分享一次就多发一条帖子。
   */
  const startPairingOnly = useCallback(async (): Promise<void> => {
    if (
      bobStatus === 'registered_not_friend' &&
      bobDid &&
      keyPackageSerializedRef.current &&
      welcomeQueueIdRef.current
    ) {
      await trackInvitePendingWelcome(
        bobDid,
        keyPackageSerializedRef.current,
        welcomeQueueIdRef.current,
      );
    }
    // 配对已进入等待状态：直接返回主页（原实现会停在「已发布」页 1.5s，
    // 真机反馈该停留页无必要 —— 页面上那组分享按钮也一并移除）
    await Taro.navigateBack();
  }, [bobStatus, bobDid, trackInvitePendingWelcome]);

  // ---- 发布帖子 ---------------------------------------------------------
  const onPublish = useCallback(async (): Promise<void> => {
    if (!pds || phase !== 'preview') return;
    setPhase('publishing');

    try {
      const qrBytes =
        bobStatus === 'registered_not_friend'
          ? await generateQrPngBytes(qrValue)
          : null;

      await createDmeInvitePost(pds, postText, qrBytes, language);

      // 只有在帖子发布**成功之后**才开始等待握手回传（与 web 顺序一致）
      await startPairingOnly();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('qrdisplay.failedPublish'));
      setPhase('error');
    }
  }, [pds, phase, bobStatus, qrValue, postText, language, startPairingOnly, t]);

  const onCancel = useCallback(async (): Promise<void> => {
    await Taro.navigateBack();
  }, []);

  const onRetry = useCallback((): void => {
    submittedRef.current = false;
    keyPackageSerializedRef.current = '';
    welcomeQueueIdRef.current = '';
    setPhase('input');
    setHandle('');
    setQrValue('');
    setPostText('');
    setErrorMsg('');
    setBobStatus(null);
  }, []);

  const onGoToChat = useCallback(async (): Promise<void> => {
    if (!bobDid) return;
    // web 用 navigation.replace('ChatView')：替换当前页，使其不进返回栈。
    // 参数名必须是 conversationId（chat-view 只认这个），isGroup 显式传 0。
    await Taro.redirectTo({
      url: `/pages/pkg-chat/chat-view/index?conversationId=${encodeURIComponent(bobDid)}&isGroup=0`,
    });
  }, [bobDid]);

  /**
   * 取当前二维码的**临时 PNG 文件路径**。
   *
   * 优先从页面上已渲染好的 `<Canvas type="2d">` 直接导出（所见即所得，
   * 且与屏幕显示完全一致）；拿不到节点时回退用离屏 canvas 重画一份。
   */
  const getQrTempFilePath = useCallback(async (): Promise<string> => {
    // 1) 优先导出现有画布
    try {
      const size = qrLayout?.size;
      const res = await Taro.canvasToTempFilePath({
        canvasId: CANVAS_ID,
        ...(size ? { x: 0, y: 0, width: size, height: size } : {}),
        fileType: 'png',
      });
      if (res.tempFilePath) return res.tempFilePath;
    } catch (err) {
      console.warn('从现有画布导出二维码失败，回退离屏重画:', err);
    }

    // 2) 回退：离屏重画（generateQrPngBytes 内部用矩阵自适应尺寸）
    const bytes = await generateQrPngBytes(qrValue);
    if (!bytes) throw new Error('二维码图片生成失败');
    return writeTempPng(bytes);
  }, [qrLayout, qrValue]);

  /**
   * 分享二维码之后：询问用户是否要**正式发出邀请**。
   *
   * 背景：分享二维码图片只是把「我的公钥包装」递给对方，真正建立 1:1 会话需要
   * 我把邀请帖发到 Bluesky（web 上就是点「发布到 Bluesky」那一步）。
   * 小程序里用户很容易只点「分享到微信」就退出，导致对方扫码后我方并未进入
   * `pendingWelcome` 等待状态 —— 握手卡住且双方都不知道原因。
   *
   * 所以这里在分享面板关闭后补一次明确的确认；选「发出邀请」就复用
   * `onPublish()` 的完整链路（含 `trackInvitePendingWelcome` 的配对等待）。
   */
  /**
   * 分享二维码之后：询问是否**进入配对流程**。
   *
   * 用户已经把二维码分享给对方了，**不再发 Bluesky 帖子** ——
   * 对方拿到的二维码本身就是我方公钥包装，扫码即可发起握手。
   * 这里确认只是把状态推进到「等待对方配对」（`pendingWelcome`）。
   *
   *   · 「确认」= 进入配对流程（**只** trackInvitePendingWelcome，不发帖）
   *   · 「取消」= 什么都不做，提示可稍后手动发布
   */
  const afterShareAsk = useCallback(async (): Promise<void> => {
    // 仅在「已注册但还不是好友」且**尚未进入配对**（phase 仍是 preview）时询问。
    // phase 已是 publishing/published 说明已在配对中，再问就是重复。
    if (bobStatus !== 'registered_not_friend' || phase !== 'preview') return;

    const res = await Taro.showModal({
      title: t('qrdisplay.askAfterShareTitle'),
      content: t('qrdisplay.askAfterShareContent'),
      confirmText: t('qrdisplay.askAfterShareConfirm'),
      cancelText: t('qrdisplay.askAfterShareDecline'),
    });

    if (!res.confirm) {
      // 取消：不进入配对流程，明确告知，避免对方干等
      await Taro.showToast({ title: t('qrdisplay.shareOnlyHint'), icon: 'none', duration: 3000 });
      return;
    }

    // 确认 = **只**进入配对流程，不发帖
    try {
      await startPairingOnly();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('qrdisplay.failedPublish'));
    }
  }, [bobStatus, phase, t, startPairingOnly]);

  /**
   * 【增强点】把二维码图片直接分享到微信聊天。
   *
   * `showShareImageMenu` 是微信原生「分享图片」面板（可发聊天/朋友圈）。
   * 若基础库不支持或调用失败，回退到「保存到相册」并提示用户手动发送。
   *
   * ⚠️ 关键坑：用户点面板右上角「×」关闭时，微信**同时**触发 `fail` 和 `complete`
   *    （部分基础库版本还会把 errMsg 写成 `showShareImageMenu:fail cancel`，
   *    另一些版本写 `fail user cancel`，还有的只回 `fail`，errMsg 里**没有** cancel 字样）。
   *    早期实现只在外层 catch 里判断 cancel，而内层 `fail` 先 reject 就进了 catch，
   *    虽然 catch 也有 cancel 判断 —— 但当 errMsg 不含 "cancel" 时就会误判成失败，
   *    于是弹出「已保存到相册」。这就是"点 × 反而提示保存"的根因。
   *
   *    正确做法：**区分「用户主动取消」和「真实失败」**。
   *    取消 = 面板正常关闭，errMsg 含 cancel/deny/关闭 等，或压根没有 errMsg。
   *    真实失败才需要回退。这里用一个更宽松的取消判定 + 只在明确失败时回退。
   *
   * ⚠️ 分享完成后（无论成功发送还是用户关掉面板）都要走 `afterShareAsk()`：
   *    分享二维码**不等于**发出邀请 —— 发帖才是握手的起点。若用户只分享没发帖，
   *    必须在面板关闭后问一次"是否正式发出邀请"，避免对方扫了码却等不到配对。
   */
  const onShareToWechat = useCallback(async (): Promise<void> => {
    if (!qrValue) return;
    let filePath: string;
    try {
      filePath = await getQrTempFilePath();
    } catch (err) {
      console.error('生成二维码图片失败:', err);
      await Taro.showToast({ title: t('common.retry'), icon: 'none' });
      return;
    }

    const api = Taro as unknown as {
      showShareImageMenu?: (o: {
        path: string;
        success?: () => void;
        fail?: (e: { errMsg?: string }) => void;
        complete?: () => void;
      }) => void;
    };

    // 基础库过低：直接走「保存到相册」这条明确路径（用户是点了分享，所以这是合理降级）
    if (typeof api.showShareImageMenu !== 'function') {
      await saveToAlbum(filePath, t);
      await afterShareAsk();
      return;
    }

    await new Promise<void>((resolve) => {
      api.showShareImageMenu!({
        path: filePath,
        // complete 在面板关闭时一定触发（成功发送 / 用户点 × 都会），
        // 放在这里问"是否发邀请"最稳，不依赖 fail/success 的版本差异。
        complete: () => resolve(),
        fail: (e) => {
          // 用户关闭面板 → 静默返回，**绝不**弹「已保存到相册」
          if (isUserCancel(e)) return;
          console.warn('showShareImageMenu 失败，回退保存相册:', e);
          void saveToAlbum(filePath, t);
        },
      });
    });

    await afterShareAsk();
  }, [qrValue, getQrTempFilePath, t, afterShareAsk]);


  // ---- 【增强点】小程序卡片转发 ------------------------------------------
  // 卡片 path 按对方状态区分（转发时动态求值）：
  //   · Bob 未注册 DME → 卡片落**主页**（先注册账号再来加好友）；
  //   · 已注册 → 卡片落 qr-scan（从相册/相机扫我方二维码完成握手）。
  // 转发卡片不携带加密载荷（载荷太大，且不该经微信传输）。
  useShareAppMessage(() => ({
    title: t('qrdisplay.shareCardTitle'),
    path:
      bobStatus === 'not_registered'
        ? '/pages/login/index'
        : '/pages/pkg-chat/qr-scan/index',
  }));

  return (
    <View className="qr">
      <ScrollView className="qr__scroll" scrollY>
        <Text className="qr__title">{t('qrdisplay.title')}</Text>

        {phase === 'input' ? (
          <View className="qr__section">
            <Text className="qr__hint">{t('qrdisplay.hint')}</Text>
            <Input
              className="qr__input"
              value={handle}
              placeholder={t('qrdisplay.handlePlaceholder')}
              confirmType="go"
              onInput={(e) => setHandle(e.detail.value)}
              onConfirm={() => void onCheckBob()}
            />
            <Button className="qr__button" onClick={() => void onCheckBob()}>
              {t('qrdisplay.checkGenerate')}
            </Button>
            <Button className="qr__button qr__button--ghost" onClick={() => void onCancel()}>
              {t('common.back')}
            </Button>
          </View>
        ) : null}

        {phase === 'checking' ? <Text className="qr__hint">{t('qrdisplay.checking')}</Text> : null}

        {phase === 'preview' ? (
          <View className="qr__section">
            <View className="qr__previewBox">
              <Text className="qr__previewLabel">{t('qrdisplay.previewLabel')}</Text>
              <Textarea
                className="qr__previewInput"
                value={postText}
                autoHeight
                onInput={(e) => setPostText(e.detail.value)}
              />
            </View>

            {matrix && qrLayout ? (
              <View className="qr__canvasWrap">
                {/*
                 * ⚠️ 二维码必须严格 1:1 —— width / height 取**同一个值**。
                 *
                 * 这里要区分两个量，混用必出 bug：
                 *   · 显示尺寸 = `QR_DISPLAY_RPX` rpx（按屏宽等比缩放，不占满屏）
                 *   · 绘制分辨率 = `qrLayout.size` px（喂给 canvas.width/height，保证清晰）
                 * 我们只把**显示尺寸**交给样式；绘制分辨率由下面的 effect 设到
                 * canvas 节点上（两者可以不同，但各自都必须宽高相等）。
                 *
                 * canvas 是原生元素、**没有固有宽高比**，CSS 里任何单轴的
                 * width/height 规则都会把它拉变形（详见 index.scss `&__canvas` 注释）。
                 */}
                <Canvas
                  type="2d"
                  id={CANVAS_ID}
                  canvasId={CANVAS_ID}
                  className="qr__canvas"
                  style={{
                    width: `${QR_DISPLAY_RPX}rpx`,
                    height: `${QR_DISPLAY_RPX}rpx`,
                  }}
                />
              </View>
            ) : null}

            <Button className="qr__button" onClick={() => void onPublish()}>
              {t('qrdisplay.publish')}
            </Button>
            {bobStatus === 'registered_not_friend' ? (
              /* 增强点：二维码直接分享给微信好友（在发布前也能分享） */
              <Button className="qr__button qr__button--ghost" onClick={() => void onShareToWechat()}>
                {t('common.share')}
              </Button>
            ) : (
              /* Bob 还没注册 DME：分享小程序卡片（落主页），让他先来注册 */
              <Button className="qr__button qr__button--ghost" openType="share">
                {t('common.shareCard')}
              </Button>
            )}
            <Button className="qr__button qr__button--ghost" onClick={() => void onCancel()}>
              {t('common.cancel')}
            </Button>
          </View>
        ) : null}

        {phase === 'already_friend' ? (
          <View className="qr__section">
            <Text className="qr__hint">
              {t('qrdisplay.alreadyFriend', { handle: bobHandle })}
            </Text>
            <Button className="qr__button" onClick={() => void onGoToChat()}>
              {t('qrdisplay.goToChat')}
            </Button>
            <Button className="qr__button qr__button--ghost" onClick={() => void onCancel()}>
              {t('common.back')}
            </Button>
          </View>
        ) : null}

        {phase === 'publishing' ? (
          <Text className="qr__hint">{t('qrdisplay.publishing')}</Text>
        ) : null}

        {phase === 'error' ? (
          <View className="qr__section">
            <Text className="qr__error">{errorMsg}</Text>
            <Button className="qr__button" onClick={onRetry}>
              {t('common.tryAgain')}
            </Button>
            <Button className="qr__button qr__button--ghost" onClick={() => void onCancel()}>
              {t('common.back')}
            </Button>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** 把 PNG 字节写到临时文件，返回 filePath（供分享/保存相册使用）。 */
function writeTempPng(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const fs = Taro.getFileSystemManager();
    const filePath = `${Taro.env.USER_DATA_PATH}/dme-invite-${Date.now()}.png`;
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    fs.writeFile({
      filePath,
      data: buffer,
      success: () => resolve(filePath),
      fail: (err) => reject(new Error(err.errMsg ?? 'writeFile 失败')),
    });
  });
}

/**
 * 判定 `showShareImageMenu` 的失败回调是否属于「用户主动取消/关闭面板」。
 *
 * 不同基础库版本回传的 errMsg 五花八门，实测见过：
 *   - `showShareImageMenu:fail cancel`
 *   - `showShareImageMenu:fail user cancel`
 *   - `showShareImageMenu:fail deny`
 *   - `showShareImageMenu:fail`（**完全没有** cancel 字样）
 *   - 回调参数为 undefined / 空对象
 *
 * 判定原则：**宁可当成取消，也不要误弹「已保存到相册」**。
 * 因为「取消」是高频操作，误报会直接打断用户；
 * 而把真实失败当取消，用户最多是没分享出去、再点一次 —— 代价小得多。
 * 因此这里采用宽松匹配：只要没有明确的失败原因，就当作取消。
 */
function isUserCancel(e: { errMsg?: string } | undefined | null): boolean {
  const msg = (e?.errMsg ?? '').toLowerCase();
  // 明确是非取消类失败才放行去回退；其余（含空 errMsg）一律视为取消
  if (!msg) return true;
  if (/cancel|取消|deny|拒绝|close|关闭/.test(msg)) return true;
  // 形如 "xxx:fail" / "xxx:fail " 这种没有具体原因的，也当取消
  if (/^[^:]*:fail\s*$/.test(msg)) return true;
  return false;
}

/** 保存二维码到相册并提示（分享不可用时的降级路径）。 */
async function saveToAlbum(
  filePath: string,
  t: (key: string) => string,
): Promise<void> {
  try {
    await Taro.saveImageToPhotosAlbum({ filePath });
    await Taro.showToast({ title: t('common.saved'), icon: 'success' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/cancel|取消|auth deny|authorize/i.test(msg)) {
      // 用户拒绝相册权限，或主动取消保存 —— 不弹错误
      return;
    }
    console.error('保存二维码到相册失败:', err);
    await Taro.showToast({ title: t('common.retry'), icon: 'none' });
  }
}
