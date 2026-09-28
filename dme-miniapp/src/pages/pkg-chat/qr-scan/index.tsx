/**
 * pages/pkg-chat/qr-scan/index.tsx - 扫码接受邀请（Bob 侧）。
 *
 * 与 dme-client/src/ui/QrScanScreen.tsx 的 5 阶段状态机**逐阶段对应**：
 *
 *   idle        [从相册识别] / [摄像头扫码] / [返回]
 *   scanning    正在识别
 *   confirm     显示 aliceHandle + [接受] / [拒绝]
 *   processing  [接受] 中，等待 acceptInviteQr 完成
 *   error       显示错误 + [重试]
 *
 * 平台差异（相对 web）：
 *   - web 用 expo-image-picker 选图 + canvas 取像素 + jsQR 解码；
 *     小程序改为 `wx.chooseMedia` → `canvas 2d` 取 ImageData → jsQR。
 *   - 【增强点】web 只能从相册选图；小程序额外提供 `wx.scanCode`
 *     直接调摄像头实时扫码。**不替代**原相册路径。
 */

import { useCallback, useState } from 'react';
import { View, Text, Button, Canvas } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { useApp } from '../../../state/AppContext';
import { useI18n } from '../../../i18n/I18nContext';
import { useWebTitle } from '../../../utils/web-title';
import { decodeQrPayload } from '../../../handshake/qr-encode';
import { resolveHandleCached } from '../../../atproto/profile-cache';
import { decodeQrFromImageData } from '../../../handshake/qr-image-decode';
import './index.scss';

type Status = 'idle' | 'scanning' | 'confirm' | 'processing' | 'error';

/** 解码用画布 id（离屏渲染时用来取像素）。 */
const DECODE_CANVAS_ID = 'dme-qr-decode';

export default function QrScanPage(): React.JSX.Element {
  const { t } = useI18n();
  const { acceptInviteQr, session } = useApp();

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [aliceHandle, setAliceHandle] = useState('');
  const [qrString, setQrString] = useState<string | null>(null);
  const [showDecodeCanvas, setShowDecodeCanvas] = useState(false);

  useWebTitle(t('qrscan.title'));

  /** 解析 DID → handle；失败时退回 DID（与 web 行为一致）。 */
  const resolveHandle = async (did: string): Promise<string> => {
    try {
      return await resolveHandleCached(did);
    } catch (err) {
      console.error('QrScan: resolveHandle failed for', did, err);
    }
    return did;
  };

  /**
   * 从相册选一张图，用 canvas 取像素后交给 jsQR 解码。
   *
   * 对应 web 的 `pickQrString()`：
   *   expo ImagePicker → new Image() → canvas.drawImage → getImageData → jsQR
   * 小程序：`wx.chooseMedia` → Image → 离屏/页面 canvas → getImageData → jsQR
   */
  const pickQrString = useCallback(async (): Promise<string | null> => {
    const res = await Taro.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album'],
    });
    const file = res.tempFiles?.[0];
    if (!file?.tempFilePath) return null;

    // 展示隐藏画布（NeedCanvas 节点必须在页面里才能 createSelectorQuery 拿到）
    setShowDecodeCanvas(true);
    // 等一帧，确保 Canvas 节点已挂载
    await new Promise((r) => setTimeout(r, 60));

    try {
      const canvas = await new Promise<{
        width: number;
        height: number;
        getContext(type: string): unknown;
        createImage?(): { src: string; onload: (() => void) | null; onerror: (() => void) | null };
      } | null>((resolve) => {
        Taro.createSelectorQuery()
          .select(`#${DECODE_CANVAS_ID}`)
          .fields({ node: true, size: true })
          .exec((r2) => {
            const first = r2?.[0] as { node?: never } | undefined;
            resolve((first?.node as never) ?? null);
          });
      });
      if (!canvas) return null;

      const data = await decodeQrFromImageData(canvas, file.tempFilePath);
      return data;
    } finally {
      setShowDecodeCanvas(false);
    }
  }, []);

  const onScan = useCallback(async (): Promise<void> => {
    setStatus('scanning');
    setError(null);

    try {
      const decoded = await pickQrString();
      if (!decoded) {
        setStatus('idle');
        return;
      }

      const payload = decodeQrPayload(decoded);
      if (payload.aliceDid === session?.did) {
        throw new Error(t('qrscan.cantAcceptSelf'));
      }
      const handle = await resolveHandle(payload.aliceDid);
      setAliceHandle(handle);
      setQrString(decoded);
      setStatus('confirm');
    } catch (err) {
      // 用户取消选图不算错误
      const msg = err instanceof Error ? err.message : t('qrscan.failedScan');
      if (/cancel|取消/i.test(msg)) {
        setStatus('idle');
        return;
      }
      console.error('[QrScan] scan error:', msg, err);
      setError(msg);
      setStatus('error');
    }
  }, [pickQrString, session, t]);

  /**
   * 【增强点】直接调摄像头实时扫码（web 无此能力）。
   *
   * 拿到字符串后走**完全相同的**后续流程（decodeQrPayload → 确认页）。
   */
  const onCameraScan = useCallback(async (): Promise<void> => {
    setStatus('scanning');
    setError(null);
    try {
      const res = await Taro.scanCode({ onlyFromCamera: true, scanType: ['qrCode'] });
      const decoded = res.result;
      if (!decoded) {
        setStatus('idle');
        return;
      }
      const payload = decodeQrPayload(decoded);
      if (payload.aliceDid === session?.did) {
        throw new Error(t('qrscan.cantAcceptSelf'));
      }
      const handle = await resolveHandle(payload.aliceDid);
      setAliceHandle(handle);
      setQrString(decoded);
      setStatus('confirm');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/cancel|取消/i.test(msg)) {
        setStatus('idle');
        return;
      }
      console.error('[QrScan] camera scan error:', msg, err);
      setError(msg);
      setStatus('error');
    }
  }, [session, t]);

  const onAccept = useCallback(async (): Promise<void> => {
    if (!qrString) return;
    setStatus('processing');
    try {
      await acceptInviteQr(qrString);
      await Taro.showToast({ title: t('qrscan.accepting'), icon: 'success', duration: 1200 });
      setTimeout(() => {
        void Taro.navigateBack();
      }, 600);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('qrscan.failedAccept');
      console.error('[QrScan] accept error:', msg, err);
      setError(msg);
      setStatus('error');
    }
  }, [acceptInviteQr, qrString, t]);

  const onDecline = useCallback((): void => {
    setQrString(null);
    setAliceHandle('');
    setStatus('idle');
  }, []);

  return (
    <View className="qrscan">
      <Text className="qrscan__title">{t('qrscan.title')}</Text>

      {status === 'scanning' ? (
        <Text className="qrscan__status">{t('qrscan.opening')}</Text>
      ) : null}

      {status === 'processing' ? (
        <Text className="qrscan__status">{t('qrscan.accepting')}</Text>
      ) : null}

      {status === 'confirm' ? (
        <View className="qrscan__section">
          <Text className="qrscan__status">
            {t('qrscan.confirmMessage', { handle: aliceHandle })}
          </Text>
          <Text className="qrscan__sub">{t('qrscan.confirmSub')}</Text>
        </View>
      ) : null}

      {error ? <Text className="qrscan__error">{error}</Text> : null}

      {status !== 'processing' && status !== 'confirm' ? (
        <View className="qrscan__section">
          <Button
            className="qrscan__button"
            disabled={status === 'scanning'}
            onClick={() => void onScan()}
          >
            {status === 'scanning' ? t('qrscan.scanning') : t('qrscan.scanFromGallery')}
          </Button>
          {/* 增强点：摄像头实时扫码（web 只能相册选图） */}
          <Button
            className="qrscan__button qrscan__button--ghost"
            disabled={status === 'scanning'}
            onClick={() => void onCameraScan()}
          >
            {t('qrscan.cameraScan')}
          </Button>
        </View>
      ) : null}

      {status === 'confirm' ? (
        <View className="qrscan__section">
          <Button className="qrscan__button" onClick={() => void onAccept()}>
            {t('common.accept')}
          </Button>
          <Button className="qrscan__button qrscan__button--ghost" onClick={onDecline}>
            {t('common.decline')}
          </Button>
        </View>
      ) : null}

      {status === 'error' ? (
        <Button className="qrscan__button qrscan__button--ghost" onClick={() => setStatus('idle')}>
          {t('common.tryAgain')}
        </Button>
      ) : null}

      <Button
        className="qrscan__button qrscan__button--ghost"
        onClick={() => void Taro.navigateBack()}
      >
        {t('common.back')}
      </Button>

      {/* 解码用隐藏画布：只有挂载后才能拿到 2d context 取像素 */}
      {showDecodeCanvas ? (
        <Canvas
          type="2d"
          id={DECODE_CANVAS_ID}
          canvasId={DECODE_CANVAS_ID}
          className="qrscan__decodeCanvas"
        />
      ) : null}
    </View>
  );
}
