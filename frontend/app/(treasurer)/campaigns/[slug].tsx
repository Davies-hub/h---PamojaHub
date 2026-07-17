import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsWideWeb } from '../../../components/layout/Screen';
import ProgressBar from '../../../components/ui/ProgressBar';
import RemoteImage from '../../../components/ui/RemoteImage';
import ResponsiveSheet from '../../../components/ui/ResponsiveSheet';
import { BorderRadius, Colors, FontSize, Shadows, Spacing } from '../../../constants/theme';
import { useFocusRefetch } from '../../../hooks/useFocusRefetch';
import { campaignsService } from '../../../services/campaigns.service';
import { withdrawalsService } from '../../../services/withdrawals.service';
import {
  CampaignCategory,
  CampaignStatus,
  TreasurerCampaign,
  Withdrawal,
  WithdrawalStatus,
} from '../../../types';
import { fmtKes, formatDate } from '../../../utils/formatters';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CAMPAIGN_BASE_URL = 'https://pamojahub.co.ke/campaigns';

// Display-only masking of the payout destination phone (same shape as payouts.tsx).
// The serializer returns the FULL number on this authorized surface; masking is a
// presentation concern so the on-screen history never shows the whole MSISDN.
function maskPhone(phone: string): string {
  if (!phone || phone.length < 4) return '****';
  return `0*** ***${phone.slice(-4)}`;
}

// Pull the server's error message out of a 400/403 so the banner card can show
// the REAL reason. The banner endpoint answers in TWO shapes: its own guards return
// {"detail": "..."} but the image validator raises DRF ValidationError, which
// serializes as a bare LIST (["Unsupported image type."]) — handle both.
function extractDetail(err: unknown): string | undefined {
  if (axios.isAxiosError(err) && err.response) {
    const data = err.response.data as unknown;
    const d = (data as { detail?: unknown })?.detail;
    if (typeof d === 'string' && d.trim()) return d;
    if (Array.isArray(data) && typeof data[0] === 'string' && data[0].trim()) return data[0];
  }
  return undefined;
}

// A 403 (cross-church) or 404 (no such slug) is NOT an error to retry — it's a
// distinct "not found / not yours" state. Anything else (network, 5xx) is a real
// error the user can retry.
function isNotFound(err: unknown): boolean {
  const s = (err as { response?: { status?: number } })?.response?.status;
  return s === 403 || s === 404;
}

const STATUS_COLORS: Record<CampaignStatus, { bg: string; text: string }> = {
  ACTIVE:  { bg: Colors.successLight, text: Colors.success },
  PAUSED:  { bg: Colors.warningLight, text: Colors.warning },
  CLOSED:  { bg: Colors.grey,         text: Colors.textMuted },
};

const CATEGORY_ICON: Partial<Record<CampaignCategory, React.ComponentProps<typeof Ionicons>['name']>> = {
  Building:  'construct-outline',
  Education: 'school-outline',
  Outreach:  'people-outline',
  Youth:     'happy-outline',
  Medical:   'medkit-outline',
  Relief:    'heart-outline',
  Other:     'ellipsis-horizontal-outline',
};

// Payout (withdrawal) status presentation — mirrors payouts.tsx so the history
// section reads identically to the Payouts tab.
const PAYOUT_STATUS_LABELS: Record<WithdrawalStatus, string> = {
  PENDING_APPROVAL:     'Pending',
  PROCESSING:           'Processing',
  PAID:                 'Paid',
  FAILED:               'Failed',
  FAILED_FINAL:         'Failed Final',
  REJECTED:             'Rejected',
  NEEDS_RECONCILIATION: 'Under Review',
};

const PAYOUT_STATUS_BADGE: Record<WithdrawalStatus, { bg: string; text: string }> = {
  PENDING_APPROVAL:     { bg: Colors.warningLight, text: Colors.warning },
  PROCESSING:           { bg: Colors.primaryLight, text: Colors.primary },
  PAID:                 { bg: Colors.successLight, text: Colors.success },
  FAILED:               { bg: Colors.dangerLight,  text: Colors.danger },
  FAILED_FINAL:         { bg: Colors.danger,       text: Colors.white },
  REJECTED:             { bg: Colors.grey,         text: Colors.textMuted },
  NEEDS_RECONCILIATION: { bg: Colors.accentLight,  text: Colors.accentDark },
};

// Leading icon per payout status — drives the history rows' status circles.
const PAYOUT_STATUS_ICON: Record<WithdrawalStatus, React.ComponentProps<typeof Ionicons>['name']> = {
  PENDING_APPROVAL:     'time-outline',
  PROCESSING:           'sync-outline',
  PAID:                 'checkmark-done-outline',
  FAILED:               'close-outline',
  FAILED_FINAL:         'alert-outline',
  REJECTED:             'ban-outline',
  NEEDS_RECONCILIATION: 'search-outline',
};

function pctFunded(raised: number, goal: number): number {
  if (!goal) return 0;
  return Math.min(100, Math.round((raised / goal) * 100));
}

// What the combined focus-fetch returns: the campaign detail (null = not-found
// sentinel) plus this campaign's payout history. Both refresh on every focus.
interface DetailData {
  campaign: TreasurerCampaign | null;
  history: Withdrawal[];
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: CampaignStatus }) {
  const c = STATUS_COLORS[status];
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <Text style={[styles.badgeText, { color: c.text }]}>
        {status.charAt(0) + status.slice(1).toLowerCase()}
      </Text>
    </View>
  );
}

function PayoutStatusBadge({ status }: { status: WithdrawalStatus }) {
  const c = PAYOUT_STATUS_BADGE[status];
  return (
    <View style={[styles.payoutBadge, { backgroundColor: c.bg }]}>
      <Text style={[styles.payoutBadgeText, { color: c.text }]}>
        {PAYOUT_STATUS_LABELS[status]}
      </Text>
    </View>
  );
}

function BackBar({ onBack, status }: { onBack: () => void; status?: CampaignStatus }) {
  return (
    <View style={styles.backBar}>
      <TouchableOpacity
        style={styles.backBtn}
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back to Campaigns"
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Ionicons name="arrow-back" size={18} color={Colors.primary} />
        <Text style={styles.backBtnText}>Campaigns</Text>
      </TouchableOpacity>
      {status ? <StatusBadge status={status} /> : null}
    </View>
  );
}

// Disbursement (payout) history — status-coded icon circles, NET amount, date,
// masked destination phone, and the M-Pesa receipt (payout_reference) once PAID.
function PayoutHistorySection({ history }: { history: Withdrawal[] }) {
  return (
    <View style={styles.card}>
      <Text style={styles.sectionEyebrow}>PAYOUT HISTORY</Text>
      {history.length === 0 ? (
        <View style={styles.historyEmpty}>
          <View style={styles.historyEmptyIcon}>
            <Ionicons name="receipt-outline" size={22} color={Colors.primary} />
          </View>
          <Text style={styles.historyEmptyText}>No payouts yet for this campaign.</Text>
        </View>
      ) : (
        history.map((w, i) => {
          const badge = PAYOUT_STATUS_BADGE[w.status];
          return (
            <View key={w.id} style={[styles.historyRow, i === 0 && styles.historyRowFirst]}>
              <View style={[styles.historyIconCircle, { backgroundColor: badge.bg }]}>
                <Ionicons
                  name={PAYOUT_STATUS_ICON[w.status]}
                  size={17}
                  color={w.status === 'FAILED_FINAL' ? Colors.white : badge.text}
                />
              </View>
              <View style={styles.historyBody}>
                <View style={styles.historyRowTop}>
                  <Text style={styles.historyAmount}>{fmtKes(w.amount)}</Text>
                  <PayoutStatusBadge status={w.status} />
                </View>
                <View style={styles.historyMeta}>
                  <Ionicons name="phone-portrait-outline" size={11} color={Colors.textMuted} />
                  <Text style={styles.historyMetaText}>{maskPhone(w.destinationPhone)}</Text>
                  <Text style={styles.historyDot}>·</Text>
                  <Text style={styles.historyMetaText}>{formatDate(w.createdAt)}</Text>
                </View>
                {w.payoutReference ? (
                  <View style={styles.historyReceiptRow}>
                    <Ionicons name="checkmark-circle-outline" size={12} color={Colors.success} />
                    <Text style={styles.historyReceiptText}>Receipt {w.payoutReference}</Text>
                  </View>
                ) : null}
              </View>
            </View>
          );
        })
      )}
    </View>
  );
}

// ─── Campaign detail screen ───────────────────────────────────────────────────

export default function TreasurerCampaignDetailScreen() {
  const isWideWeb = useIsWideWeb();
  const router = useRouter();
  // bannerFailed=1 arrives from the create form when the campaign was CREATED but
  // its deferred banner upload failed — a non-blocking notice; this banner block is
  // the retry path.
  const { slug, bannerFailed } = useLocalSearchParams<{ slug: string; bannerFailed?: string }>();

  // ── Live data: detail + history, refetched on every focus ──────────────────
  // getMine is SLUG-keyed; its returned id (UUID) keys the history filter. A
  // 403/404 on the detail resolves to a not-found sentinel (campaign=null) so the
  // screen shows "not found" rather than the retryable error state.
  const fetcher = useCallback(async (): Promise<DetailData> => {
    let campaign: TreasurerCampaign;
    try {
      campaign = await campaignsService.getMine(slug);
    } catch (err) {
      if (isNotFound(err)) return { campaign: null, history: [] };
      throw err;
    }
    const history = await withdrawalsService.list({ campaign: campaign.id });
    return { campaign, history };
  }, [slug]);

  const { data, status, retry } = useFocusRefetch<DetailData>(fetcher);

  const detail = data?.campaign ?? null;
  const history = data?.history ?? [];

  // Pause/Resume/Close write state (wired — mirrors the campaigns LIST screen's
  // runner: write → refetch server truth, NO optimistic flip). `acting` names the
  // action in flight so only that button shows its busy label; actionError is the
  // inline feedback channel. Close confirms via ResponsiveSheet (web-safe — the
  // list's Alert.alert confirm no-ops on web).
  const [acting, setActing] = useState<'pause' | 'resume' | 'close' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  // ── Banner upload state — the override reflects the upload RESPONSE (server
  // truth) immediately; any focus-refetch re-establishes it from the detail read.
  const [bannerOverride, setBannerOverride] = useState<string | null>(null);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  useEffect(() => {
    setBannerOverride(null);
    setBannerError(null);
  }, [detail?.id, detail?.bannerImageUrl]);

  // Pick an image → upload to /campaigns/mine/{slug}/banner/ (multipart) → show the
  // server-set banner_image_url from the response. All FE checks here are UX ONLY —
  // the backend re-validates permission/size/format/re-encode regardless. Failures
  // render INLINE (not Alert.alert — it no-ops on web).
  async function handleUploadBanner() {
    if (uploadingBanner) return;
    setBannerError(null);

    // Permission gate (UX): on web this resolves granted; on native it prompts.
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setBannerError('Allow photo access to add a banner image.');
      return;
    }

    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.9,
    });
    if (res.canceled) return;
    const asset = res.assets[0];

    // UX-only pre-check — a friendly early reject; the server re-checks the real size.
    if (asset.fileSize && asset.fileSize > 5 * 1024 * 1024) {
      setBannerError('Image is over 5 MB — choose a smaller one.');
      return;
    }

    setUploadingBanner(true);
    try {
      const updated = await campaignsService.uploadBanner(slug, {
        uri: asset.uri,
        fileName: asset.fileName ?? undefined,
        mimeType: asset.mimeType ?? undefined,
      });
      setBannerOverride(updated.bannerImageUrl ?? null);   // server truth from the response
    } catch (e) {
      // Surface the server's 400 detail (too large / bad format / re-encode reject).
      setBannerError(extractDetail(e) ?? 'Could not upload the banner. Please try again.');
    } finally {
      setUploadingBanner(false);
    }
  }

  // ── Loading / error / not-found states ─────────────────────────────────────

  if (status === 'loading' && !data) {
    return (
      <SafeAreaView edges={['bottom']} style={styles.root}>
        <BackBar onBack={() => (router.canGoBack() ? router.back() : router.replace('/(treasurer)/campaigns' as any))} />
        <View style={styles.centerState}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (status === 'error') {
    return (
      <SafeAreaView edges={['bottom']} style={styles.root}>
        <BackBar onBack={() => (router.canGoBack() ? router.back() : router.replace('/(treasurer)/campaigns' as any))} />
        <View style={styles.notFound}>
          <View style={styles.stateIconCircle}>
            <Ionicons name="cloud-offline-outline" size={28} color={Colors.primary} />
          </View>
          <Text style={styles.notFoundTitle}>Couldn’t load this campaign</Text>
          <Text style={styles.notFoundSubtitle}>Please check your connection and try again.</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={retry}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text style={styles.retryBtnText}>Try again</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (!detail) {
    return (
      <SafeAreaView edges={['bottom']} style={styles.root}>
        <BackBar onBack={() => (router.canGoBack() ? router.back() : router.replace('/(treasurer)/campaigns' as any))} />
        <View style={styles.notFound}>
          <View style={styles.stateIconCircle}>
            <Ionicons name="alert-circle-outline" size={28} color={Colors.primary} />
          </View>
          <Text style={styles.notFoundTitle}>Campaign not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const displayStatus = detail.status;
  const pct = pctFunded(detail.walletBalance, detail.goalAmount);
  const categoryIcon = detail.category ? (CATEGORY_ICON[detail.category] ?? 'pricetag-outline') : null;

  // ── Actions (Pause/Resume/Close — wired; same discipline as the list screen) ──

  async function runStatusAction(action: 'pause' | 'resume' | 'close') {
    if (acting) return;                 // re-entry guard: one action in flight at a time
    setActionError(null);
    setActing(action);
    try {
      if (action === 'pause') await campaignsService.pauseCampaign(slug);
      else if (action === 'resume') await campaignsService.resumeCampaign(slug);
      else await campaignsService.closeCampaign(slug);
      // SUCCESS (200): re-sync from server truth — the status flips only now,
      // via the refetch. No optimistic mutation (matches the list screen).
      retry();
    } catch (err) {
      // Do NOT flip. A 400 (detail present) — wrong-status race OR the in-flight-money
      // guard ("…withdrawal in progress…") — gets shown and triggers a refetch so a
      // stale status self-corrects. A bare network failure shows the generic message.
      const detailMsg = extractDetail(err);
      setActionError(detailMsg ?? "Couldn't update. Try again.");
      if (detailMsg !== undefined) retry();
    } finally {
      setActing(null);
      setShowCloseConfirm(false);
    }
  }

  function handlePause() { runStatusAction('pause'); }
  function handleResume() { runStatusAction('resume'); }
  // Close is destructive → confirm first via ResponsiveSheet (web-safe; Alert.alert
  // no-ops on web).
  function handleClose() {
    if (acting) return;
    setActionError(null);
    setShowCloseConfirm(true);
  }

  async function handleShare() {
    const msg = `Support our campaign: ${detail!.title}\n${CAMPAIGN_BASE_URL}/${detail!.slug}`;
    const waUrl = `whatsapp://send?text=${encodeURIComponent(msg)}`;
    const canOpen = await Linking.canOpenURL(waUrl).catch(() => false);
    Linking.openURL(canOpen ? waUrl : `https://wa.me/?text=${encodeURIComponent(msg)}`);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView edges={['bottom']} style={styles.root}>
      <BackBar onBack={() => (router.canGoBack() ? router.back() : router.replace('/(treasurer)/campaigns' as any))} status={displayStatus} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, isWideWeb && styles.wideCap]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── HERO — the campaign's money story on the brand gradient ── */}
        <LinearGradient
          colors={[Colors.primaryDark, Colors.primary]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.heroCard}
        >
          <View pointerEvents="none" style={styles.heroOrnamentA} />
          <View pointerEvents="none" style={styles.heroOrnamentB} />

          <View style={styles.heroTopRow}>
            <View style={styles.heroAvatar}>
              <Text style={styles.heroAvatarText}>
                {detail.title.charAt(0).toUpperCase()}
              </Text>
            </View>
            <View style={styles.heroTitleWrap}>
              <Text style={styles.heroTitle}>{detail.title}</Text>
              <View style={styles.heroBadgeRow}>
                {detail.groupLabelName ? (
                  <View style={styles.heroPill}>
                    <Ionicons name="people-outline" size={11} color={Colors.white} />
                    <Text style={styles.heroPillText}>{detail.groupLabelName}</Text>
                  </View>
                ) : null}
                {detail.category && categoryIcon ? (
                  <View style={styles.heroPill}>
                    <Ionicons name={categoryIcon} size={11} color={Colors.white} />
                    <Text style={styles.heroPillText}>{detail.category}</Text>
                  </View>
                ) : null}
              </View>
            </View>
          </View>

          <View style={styles.heroDivider} />

          <View style={styles.heroMoneyRow}>
            <View style={styles.heroMoneyCell}>
              <Text style={styles.heroRaised} numberOfLines={1} adjustsFontSizeToFit>
                {fmtKes(detail.walletBalance)}
              </Text>
              <Text style={styles.heroMoneyLabel}>raised</Text>
            </View>
            <View style={styles.heroMoneyCellRight}>
              <Text style={styles.heroGoal} numberOfLines={1}>
                {fmtKes(detail.goalAmount)}
              </Text>
              <Text style={styles.heroMoneyLabel}>goal</Text>
            </View>
          </View>
        </LinearGradient>

        {/* ── Floating progress card — overlaps the hero's bottom edge ── */}
        <View style={styles.floatCard}>
          <View style={styles.floatTopRow}>
            <View style={styles.pctPill}>
              <Text style={styles.pctPillText}>{pct}% funded</Text>
            </View>
            {detail.donorCount !== undefined ? (
              <View style={styles.floatMetaItem}>
                <Ionicons name="people-outline" size={14} color={Colors.textSecondary} />
                <Text style={styles.floatMetaText}>
                  {detail.donorCount} {detail.donorCount === 1 ? 'donor' : 'donors'}
                </Text>
              </View>
            ) : null}
            {detail.createdAt ? (
              <View style={styles.floatMetaItem}>
                <Ionicons name="calendar-outline" size={14} color={Colors.textSecondary} />
                <Text style={styles.floatMetaText}>{formatDate(detail.createdAt)}</Text>
              </View>
            ) : null}
          </View>
          <ProgressBar raised={detail.walletBalance} goal={detail.goalAmount} height={8} showLabels={false} />
        </View>

        {/* ── Description ── */}
        {detail.description ? (
          <View style={styles.card}>
            <Text style={styles.sectionEyebrow}>ABOUT THIS CAMPAIGN</Text>
            <Text style={styles.description}>{detail.description}</Text>
          </View>
        ) : null}

        {/* ── Banner image — upload/replace (server-validated; closed = read-only) ── */}
        <View style={styles.card}>
          <Text style={styles.sectionEyebrow}>BANNER IMAGE</Text>
          {bannerFailed === '1' && !bannerOverride ? (
            <View style={styles.bannerFailedNotice} accessibilityLiveRegion="polite">
              <Ionicons name="information-circle-outline" size={16} color={Colors.warning} />
              <Text style={styles.bannerFailedNoticeText}>
                Campaign created. Banner upload failed — add it below.
              </Text>
            </View>
          ) : null}
          {(bannerOverride ?? detail.bannerImageUrl) ? (
            <>
              <RemoteImage
                uri={bannerOverride ?? detail.bannerImageUrl}
                style={styles.bannerImage}
                resizeMode="cover"
                fallback={
                  <View style={styles.bannerPlaceholder}>
                    <Ionicons name="image-outline" size={28} color={Colors.primary} />
                  </View>
                }
              />
              {displayStatus !== 'CLOSED' ? (
                <TouchableOpacity
                  style={styles.bannerReplaceBtn}
                  onPress={handleUploadBanner}
                  disabled={uploadingBanner}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="Replace banner"
                >
                  {uploadingBanner ? (
                    <ActivityIndicator size="small" color={Colors.primary} />
                  ) : (
                    <>
                      <Ionicons name="image-outline" size={16} color={Colors.primary} />
                      <Text style={styles.bannerReplaceBtnText}>Replace banner</Text>
                    </>
                  )}
                </TouchableOpacity>
              ) : null}
            </>
          ) : displayStatus !== 'CLOSED' ? (
            <TouchableOpacity
              style={styles.bannerUploadBox}
              onPress={handleUploadBanner}
              disabled={uploadingBanner}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Add banner image"
            >
              {uploadingBanner ? (
                <ActivityIndicator size="small" color={Colors.primary} />
              ) : (
                <Ionicons name="image-outline" size={30} color={Colors.primary} />
              )}
              <Text style={styles.bannerUploadLabel}>Add banner image</Text>
              <Text style={styles.bannerUploadSublabel}>
                JPG or PNG · Recommended 1200 × 630 px · Max 5 MB
              </Text>
            </TouchableOpacity>
          ) : (
            <Text style={styles.bannerNone}>No banner image.</Text>
          )}
          {bannerError ? <Text style={styles.bannerError}>{bannerError}</Text> : null}
        </View>

        {/* ── Payout history ── */}
        <PayoutHistorySection history={history} />

        {/* ── Actions ── */}
        <View style={styles.actionsCard}>
          {/* Request payout — nav to the Payouts tab (the real request flow is the OTP
              portal, a different actor; this JWT screen only routes there). */}
          {detail.walletBalance > 0 && displayStatus !== 'CLOSED' ? (
            <TouchableOpacity
              style={styles.disbursementBtn}
              onPress={() => router.push('/(treasurer)/payouts' as any)}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Request payout"
            >
              <Ionicons name="arrow-up-circle-outline" size={18} color={Colors.white} />
              <Text style={styles.disbursementBtnText}>Request Payout</Text>
            </TouchableOpacity>
          ) : null}

          {/* WhatsApp share */}
          <TouchableOpacity
            style={styles.whatsappBtn}
            onPress={handleShare}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Share on WhatsApp"
          >
            <Ionicons name="logo-whatsapp" size={18} color="#25D366" />
            <Text style={styles.whatsappBtnText}>Share on WhatsApp</Text>
          </TouchableOpacity>

          {/* Inline write-failure surface (wrong-status race / in-flight-money guard) */}
          {actionError ? (
            <View style={styles.actionErrorRow} accessibilityLiveRegion="polite">
              <Ionicons name="alert-circle" size={15} color={Colors.danger} />
              <Text style={styles.actionErrorText}>{actionError}</Text>
            </View>
          ) : null}

          {/* Pause / Resume / Close — wired (write → refetch server truth) */}
          {displayStatus !== 'CLOSED' ? (
            <View style={styles.statusActions}>
              {displayStatus === 'ACTIVE' ? (
                <TouchableOpacity
                  style={[styles.pauseBtn, acting && styles.btnDisabled]}
                  onPress={handlePause}
                  disabled={!!acting}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="Pause campaign"
                >
                  <Ionicons name="pause-circle-outline" size={16} color={Colors.textSecondary} />
                  <Text style={styles.pauseBtnText}>{acting === 'pause' ? 'Pausing…' : 'Pause'}</Text>
                </TouchableOpacity>
              ) : null}

              {displayStatus === 'PAUSED' ? (
                <TouchableOpacity
                  style={[styles.resumeBtn, acting && styles.btnDisabled]}
                  onPress={handleResume}
                  disabled={!!acting}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="Resume campaign"
                >
                  <Ionicons name="play-circle-outline" size={16} color={Colors.primary} />
                  <Text style={styles.resumeBtnText}>
                    {acting === 'resume' ? 'Resuming…' : 'Resume Campaign'}
                  </Text>
                </TouchableOpacity>
              ) : null}

              <TouchableOpacity
                style={[styles.closeBtn, acting && styles.btnDisabled]}
                onPress={handleClose}
                disabled={!!acting}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Close campaign"
              >
                <Ionicons name="close-circle-outline" size={16} color={Colors.danger} />
                <Text style={styles.closeBtnText}>
                  {acting === 'close' ? 'Closing…' : 'Close Campaign'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.closedNotice}>
              <Ionicons name="lock-closed-outline" size={14} color={Colors.textMuted} />
              <Text style={styles.closedNoticeText}>This campaign is closed and no longer accepting donations.</Text>
            </View>
          )}
        </View>
      </ScrollView>

      {/* ── Close-campaign confirm (destructive → explicit web-safe confirm) ── */}
      <ResponsiveSheet
        visible={showCloseConfirm}
        onRequestClose={() => setShowCloseConfirm(false)}
        dismissable={!acting}
      >
        <Text style={styles.confirmTitle}>Close Campaign</Text>
        <Text style={styles.confirmBody}>
          Close “{detail.title}”?{'\n\n'}Donors will no longer be able to contribute. This
          cannot be undone.
        </Text>
        <View style={styles.confirmActions}>
          <TouchableOpacity
            style={[styles.confirmCancelBtn, acting && styles.btnDisabled]}
            onPress={() => setShowCloseConfirm(false)}
            disabled={!!acting}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={styles.confirmCancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.confirmCloseBtn, acting && styles.btnDisabled]}
            onPress={() => runStatusAction('close')}
            disabled={!!acting}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Confirm close campaign"
          >
            <Text style={styles.confirmCloseText}>
              {acting === 'close' ? 'Closing…' : 'Close Campaign'}
            </Text>
          </TouchableOpacity>
        </View>
      </ResponsiveSheet>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.surfaceSubtle },

  // Back bar (fixed strip below TreasurerTopBar)
  backBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.white,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.surfaceSubtle,
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  backBtnText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },

  // Loading state
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },

  // Not-found / error state
  notFound: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, paddingHorizontal: Spacing.xl },
  stateIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notFoundTitle: { fontFamily: 'Poppins-SemiBold', fontSize: FontSize.lg, color: Colors.text },
  notFoundSubtitle: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: Spacing.md,
    paddingHorizontal: Spacing.xl,
    height: Spacing.touch,
    borderRadius: BorderRadius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryBtnText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.white,
  },

  // Scroll
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: Spacing.xl },
  wideCap: {
    maxWidth: 760,
    width: '100%',
    alignSelf: 'center',
  },

  // Hero
  heroCard: {
    marginHorizontal: Spacing.md,
    marginTop: Spacing.md,
    borderRadius: BorderRadius.xl + 4,
    padding: Spacing.lg,
    paddingBottom: Spacing.lg + 26,
    overflow: 'hidden',
    ...Shadows.lg,
  },
  heroOrnamentA: {
    position: 'absolute',
    top: -70,
    right: -50,
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  heroOrnamentB: {
    position: 'absolute',
    bottom: -80,
    left: -60,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  heroAvatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    ...Shadows.sm,
  },
  heroAvatarText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxl,
    color: Colors.primary,
  },
  heroTitleWrap: {
    flex: 1,
    minWidth: 0,
    gap: 6,
  },
  heroTitle: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.white,
    lineHeight: FontSize.lg * 1.35,
  },
  heroBadgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  heroPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  heroPillText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.white,
  },
  heroDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.18)',
    marginVertical: Spacing.md,
  },
  heroMoneyRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: Spacing.md,
  },
  heroMoneyCell: {
    flex: 1,
    minWidth: 0,
  },
  heroMoneyCellRight: {
    alignItems: 'flex-end',
    flexShrink: 0,
  },
  heroRaised: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxxl,
    color: Colors.white,
    lineHeight: FontSize.xxxl * 1.25,
  },
  heroGoal: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.base,
    color: 'rgba(255,255,255,0.85)',
  },
  heroMoneyLabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: 11,
    color: 'rgba(255,255,255,0.72)',
    marginTop: 1,
  },

  // Floating progress card — overlaps the hero's bottom edge
  floatCard: {
    marginHorizontal: Spacing.lg + 4,
    marginTop: -30,
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    padding: Spacing.md,
    ...Shadows.lg,
  },
  floatTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Spacing.md,
    marginBottom: Spacing.sm + 2,
  },
  pctPill: {
    backgroundColor: Colors.accentLight,
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  pctPillText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.sm,
    color: Colors.accentDark,
  },
  floatMetaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  floatMetaText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },

  // Badges (campaign status in the back bar)
  badge: {
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  badgeText: { fontFamily: 'Poppins-SemiBold', fontSize: FontSize.xs },

  // Cards
  card: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    padding: Spacing.md,
    marginHorizontal: Spacing.md,
    marginTop: Spacing.md,
    gap: Spacing.sm,
    ...Shadows.sm,
  },
  sectionEyebrow: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.xs,
    letterSpacing: 1.2,
    color: Colors.textMuted,
  },

  // Description
  description: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.text,
    lineHeight: FontSize.md * 1.7,
  },

  // Banner image card
  bannerImage: {
    width: '100%',
    aspectRatio: 1200 / 630,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.grey,
  },
  bannerPlaceholder: {
    width: '100%',
    aspectRatio: 1200 / 630,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerReplaceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 42,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.primary,
    backgroundColor: Colors.white,
  },
  bannerReplaceBtnText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },
  bannerUploadBox: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: Spacing.lg,
    borderRadius: BorderRadius.lg,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceSubtle,
  },
  bannerUploadLabel: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.text,
  },
  bannerUploadSublabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  bannerNone: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  bannerError: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.danger,
  },
  bannerFailedNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: Colors.warningLight,
    borderRadius: BorderRadius.lg,
    padding: Spacing.sm + 2,
  },
  bannerFailedNoticeText: {
    flex: 1,
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.warning,
    lineHeight: 18,
  },

  // Payout history
  historyEmpty: {
    alignItems: 'center',
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
  },
  historyEmptyIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyEmptyText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm + 2,
    borderTopWidth: 1,
    borderTopColor: Colors.borderLight,
    paddingTop: Spacing.sm + 2,
    marginTop: Spacing.sm + 2,
  },
  historyRowFirst: {
    borderTopWidth: 0,
    paddingTop: 0,
    marginTop: 0,
  },
  historyIconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  historyBody: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  historyRowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  historyAmount: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.base,
    color: Colors.text,
  },
  historyMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  historyMetaText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  historyDot: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  historyReceiptRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  historyReceiptText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.success,
  },
  payoutBadge: {
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  payoutBadgeText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: 10,
  },

  // Actions card
  actionsCard: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    padding: Spacing.md,
    marginHorizontal: Spacing.md,
    marginTop: Spacing.md,
    gap: Spacing.sm,
    ...Shadows.sm,
  },
  disbursementBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 52,
    borderRadius: BorderRadius.pill,
    backgroundColor: Colors.accent,
    ...Shadows.sm,
  },
  disbursementBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.base,
    color: Colors.white,
  },
  whatsappBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 48,
    borderRadius: BorderRadius.pill,
    borderWidth: 1.5,
    borderColor: '#25D366',
    backgroundColor: Colors.white,
  },
  whatsappBtnText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: '#25D366',
  },
  statusActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  pauseBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 42,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
  },
  pauseBtnText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  resumeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 42,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryLight,
  },
  resumeBtnText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },
  closeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 42,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.danger,
    backgroundColor: Colors.dangerLight,
  },
  closeBtnText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.danger,
  },
  btnDisabled: {
    opacity: 0.55,
  },
  actionErrorRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: Colors.dangerLight,
    borderRadius: BorderRadius.lg,
    padding: Spacing.sm + 2,
  },
  actionErrorText: {
    flex: 1,
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.danger,
    lineHeight: 18,
  },

  // Close-confirm sheet
  confirmTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
    marginBottom: Spacing.sm,
  },
  confirmBody: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    lineHeight: FontSize.md * 1.6,
    marginBottom: Spacing.md,
  },
  confirmActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  confirmCancelBtn: {
    flex: 1,
    height: Spacing.touch,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmCancelText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
  },
  confirmCloseBtn: {
    flex: 1,
    height: Spacing.touch,
    borderRadius: BorderRadius.pill,
    backgroundColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmCloseText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.white,
  },

  closedNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: Colors.surfaceSubtle,
    borderRadius: BorderRadius.lg,
    padding: Spacing.sm + 2,
  },
  closedNoticeText: {
    flex: 1,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    lineHeight: 18,
  },
});
