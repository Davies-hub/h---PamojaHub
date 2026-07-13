import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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

function CategoryBadge({ category }: { category: CampaignCategory }) {
  const icon = CATEGORY_ICON[category] ?? 'pricetag-outline';
  return (
    <View style={styles.categoryBadge}>
      <Ionicons name={icon} size={11} color={Colors.primary} />
      <Text style={styles.categoryBadgeText}>{category}</Text>
    </View>
  );
}

function StatTile({
  icon,
  label,
  value,
  valueColor,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.statTile}>
      <Ionicons name={icon} size={18} color={Colors.primary} />
      <Text style={[styles.statValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
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
        <Ionicons name="arrow-back" size={20} color={Colors.primary} />
        <Text style={styles.backBtnText}>Campaigns</Text>
      </TouchableOpacity>
      {status ? <StatusBadge status={status} /> : null}
    </View>
  );
}

// Disbursement (payout) history section — NET amount, status, date, masked
// destination phone, and the M-Pesa receipt (payout_reference) once PAID.
function PayoutHistorySection({ history }: { history: Withdrawal[] }) {
  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Payout history</Text>
      {history.length === 0 ? (
        <View style={styles.historyEmpty}>
          <Ionicons name="receipt-outline" size={28} color={Colors.border} />
          <Text style={styles.historyEmptyText}>No payouts yet for this campaign.</Text>
        </View>
      ) : (
        history.map((w, i) => (
          <View key={w.id} style={[styles.historyRow, i === 0 && styles.historyRowFirst]}>
            <View style={styles.historyRowTop}>
              <Text style={styles.historyAmount}>{fmtKes(w.amount)}</Text>
              <PayoutStatusBadge status={w.status} />
            </View>
            <View style={styles.historyMeta}>
              <Ionicons name="phone-portrait-outline" size={12} color={Colors.textMuted} />
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
        ))
      )}
    </View>
  );
}

// ─── Campaign detail screen ───────────────────────────────────────────────────

export default function TreasurerCampaignDetailScreen() {
  const isWideWeb = useIsWideWeb();
  const router = useRouter();
  const { slug } = useLocalSearchParams<{ slug: string }>();

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

  // Local-only status override for the still-mock Pause/Resume/Close actions (the
  // write slice is later — these do NOT call the API). Reset whenever the server
  // detail's identity/status changes so a real refetch re-establishes server truth.
  const [statusOverride, setStatusOverride] = useState<CampaignStatus | null>(null);
  useEffect(() => {
    setStatusOverride(null);
  }, [detail?.id, detail?.status]);

  // ── Loading / error / not-found states ─────────────────────────────────────

  if (status === 'loading' && !data) {
    return (
      <SafeAreaView edges={['bottom']} style={styles.root}>
        <BackBar onBack={() => router.back()} />
        <View style={styles.centerState}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (status === 'error') {
    return (
      <SafeAreaView edges={['bottom']} style={styles.root}>
        <BackBar onBack={() => router.back()} />
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
        <BackBar onBack={() => router.back()} />
        <View style={styles.notFound}>
          <View style={styles.stateIconCircle}>
            <Ionicons name="alert-circle-outline" size={28} color={Colors.primary} />
          </View>
          <Text style={styles.notFoundTitle}>Campaign not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const displayStatus = statusOverride ?? detail.status;
  const pct = pctFunded(detail.walletBalance, detail.goalAmount);

  // ── Actions (Pause/Resume/Close = LOCAL MOCK ONLY — write slice is later) ────

  function handlePause() {
    setStatusOverride('PAUSED');
  }

  function handleResume() {
    setStatusOverride('ACTIVE');
  }

  function handleClose() {
    Alert.alert(
      'Close Campaign',
      `Close "${detail!.title}"?\n\nDonors will no longer be able to contribute. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Close Campaign',
          style: 'destructive',
          onPress: () => setStatusOverride('CLOSED'),
        },
      ],
    );
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
      <BackBar onBack={() => router.back()} status={displayStatus} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, isWideWeb && styles.wideCap]}
        showsVerticalScrollIndicator={false}
      >
        {/* Banner */}
        <LinearGradient
          colors={[Colors.primary, Colors.primaryDark]}
          style={styles.banner}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
        >
          <View style={styles.bannerInitial}>
            <Text style={styles.bannerInitialText}>
              {detail.title.charAt(0).toUpperCase()}
            </Text>
          </View>
        </LinearGradient>

        {/* Title + badges */}
        <View style={styles.titleSection}>
          <Text style={styles.campaignTitle}>{detail.title}</Text>
          <View style={styles.badgeRow}>
            {detail.groupLabelName ? (
              <View style={styles.groupBadge}>
                <Ionicons name="people-outline" size={11} color={Colors.primary} />
                <Text style={styles.groupBadgeText}>{detail.groupLabelName}</Text>
              </View>
            ) : null}
            {detail.category ? <CategoryBadge category={detail.category} /> : null}
          </View>
        </View>

        {/* Progress card */}
        <View style={styles.card}>
          <View style={styles.amountRow}>
            <View>
              <Text style={styles.raisedAmount}>{fmtKes(detail.walletBalance)}</Text>
              <Text style={styles.amountLabel}>raised</Text>
            </View>
            <Text style={styles.pctText}>{pct}%</Text>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.goalAmount}>{fmtKes(detail.goalAmount)}</Text>
              <Text style={styles.amountLabel}>goal</Text>
            </View>
          </View>
          <ProgressBar raised={detail.walletBalance} goal={detail.goalAmount} showLabels={false} />
        </View>

        {/* Stats row */}
        <View style={styles.statsRow}>
          {detail.donorCount !== undefined ? (
            <StatTile
              icon="people-outline"
              label="Donors"
              value={String(detail.donorCount)}
            />
          ) : null}
          {detail.createdAt ? (
            <StatTile
              icon="calendar-outline"
              label="Started"
              value={formatDate(detail.createdAt)}
            />
          ) : null}
          <StatTile
            icon="trending-up-outline"
            label="Funded"
            value={`${pct}%`}
            valueColor={pct >= 100 ? Colors.success : Colors.primary}
          />
        </View>

        {/* Description */}
        {detail.description ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>About this campaign</Text>
            <Text style={styles.description}>{detail.description}</Text>
          </View>
        ) : null}

        {/* Payout history */}
        <PayoutHistorySection history={history} />

        {/* Actions */}
        <View style={styles.actionsCard}>
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

          {/* Pause / Resume / Close — LOCAL MOCK ONLY (write slice is later) */}
          {displayStatus !== 'CLOSED' ? (
            <View style={styles.statusActions}>
              {displayStatus === 'ACTIVE' ? (
                <TouchableOpacity
                  style={styles.pauseBtn}
                  onPress={handlePause}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="Pause campaign"
                >
                  <Ionicons name="pause-circle-outline" size={16} color={Colors.textSecondary} />
                  <Text style={styles.pauseBtnText}>Pause</Text>
                </TouchableOpacity>
              ) : null}

              {displayStatus === 'PAUSED' ? (
                <TouchableOpacity
                  style={styles.resumeBtn}
                  onPress={handleResume}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="Resume campaign"
                >
                  <Ionicons name="play-circle-outline" size={16} color={Colors.primary} />
                  <Text style={styles.resumeBtnText}>Resume Campaign</Text>
                </TouchableOpacity>
              ) : null}

              <TouchableOpacity
                style={styles.closeBtn}
                onPress={handleClose}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Close campaign"
              >
                <Ionicons name="close-circle-outline" size={16} color={Colors.danger} />
                <Text style={styles.closeBtnText}>Close Campaign</Text>
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
  },
  backBtnText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.md,
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
  notFoundTitle: { fontFamily: 'Poppins-SemiBold', fontSize: FontSize.lg, color: Colors.text },
  notFoundSubtitle: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  stateIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
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

  // Banner
  banner: {
    height: 140,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerInitial: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerInitialText: {
    fontFamily: 'Poppins-Bold',
    fontSize: 30,
    color: Colors.white,
  },

  // Title section
  titleSection: {
    backgroundColor: Colors.white,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
    gap: Spacing.sm,
  },
  campaignTitle: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.text,
    lineHeight: 26,
  },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },

  // Badges
  badge: {
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  badgeText: { fontFamily: 'Poppins-Medium', fontSize: FontSize.xs },

  categoryBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  categoryBadgeText: { fontFamily: 'Poppins-Medium', fontSize: FontSize.xs, color: Colors.primaryDark },

  groupBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.accentLight,
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  groupBadgeText: { fontFamily: 'Poppins-Medium', fontSize: FontSize.xs, color: Colors.accentDark },

  // Card
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
  sectionTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.base,
    color: Colors.text,
  },

  // Progress card contents
  amountRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  raisedAmount: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.text,
  },
  goalAmount: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'right',
  },
  amountLabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  pctText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.accent,
  },

  // Stats row
  statsRow: {
    flexDirection: 'row',
    marginHorizontal: Spacing.md,
    marginTop: Spacing.md,
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    overflow: 'hidden',
    ...Shadows.sm,
  },
  statTile: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.md,
    gap: 4,
    borderRightWidth: 1,
    borderRightColor: Colors.borderLight,
  },
  statValue: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.sm,
    color: Colors.text,
    textAlign: 'center',
  },
  statLabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textAlign: 'center',
  },

  // Description
  description: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
  },

  // Payout history
  historyEmpty: {
    alignItems: 'center',
    paddingVertical: Spacing.md,
    gap: 6,
  },
  historyEmptyText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  historyRow: {
    borderTopWidth: 1,
    borderTopColor: Colors.borderLight,
    paddingTop: Spacing.sm,
    marginTop: Spacing.sm,
    gap: 5,
  },
  historyRowFirst: {
    borderTopWidth: 0,
    paddingTop: 0,
    marginTop: 0,
  },
  historyRowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  whatsappBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 46,
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
  disbursementBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 50,
    borderRadius: BorderRadius.pill,
    backgroundColor: Colors.primary,
  },
  disbursementBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.base,
    color: Colors.white,
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
