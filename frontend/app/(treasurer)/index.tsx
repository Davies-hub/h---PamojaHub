import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useIsWideWeb } from '../../components/layout/Screen';
import ProgressBar from '../../components/ui/ProgressBar';
import { BorderRadius, Colors, FontSize, Shadows, Spacing } from '../../constants/theme';
import { campaignsService } from '../../services/campaigns.service';
import { dashboardService } from '../../services/dashboard.service';
import { notificationsService } from '../../services/notifications.service';
import { useFocusRefetch } from '../../hooks/useFocusRefetch';
import { useAuth } from '../../stores/auth.store';
import { useNotifications } from '../../stores/notifications.store';
import { DashboardStats, RecentDonation, TreasurerCampaign } from '../../types';

// Focused-poll cadence — a deliberate freshness/cost tradeoff: fresh enough that a
// treasurer watching the dashboard sees new donations hands-off, cheap enough that
// two lightweight GETs per tick don't strain the backend or a phone's data plan.
const POLL_INTERVAL_MS = 45_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtKes(n: number): string {
  return `KES ${n.toLocaleString('en-KE')}`;
}

function timeAgo(dateStr: string): string {
  const sec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function todayLine(): string {
  return new Date().toLocaleDateString('en-KE', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
}

// Display-only initials for the donor avatar ('?' for anonymous gifts).
function donorInitials(name: string | null | undefined): string {
  const trimmed = name?.trim();
  if (!trimmed) return '?';
  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase();
}

// ─── Hero money card ──────────────────────────────────────────────────────────

function HeroStat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.heroStat}>
      <Text style={styles.heroStatValue} numberOfLines={1}>{value}</Text>
      <Text style={styles.heroStatLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

// Phone: the three stats stack as ledger rows so long KES values never truncate.
function HeroLedgerRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.heroLedgerRow}>
      <Text style={styles.heroStatLabel}>{label}</Text>
      <Text style={styles.heroLedgerValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function MoneyHeroCard({ stats }: { stats: DashboardStats }) {
  const isWideWeb = useIsWideWeb();
  return (
    <LinearGradient
      colors={[Colors.primaryDark, Colors.primary]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.heroCard}
    >
      <View pointerEvents="none" style={styles.heroOrnamentA} />
      <View pointerEvents="none" style={styles.heroOrnamentB} />

      <Text style={styles.heroEyebrow}>TOTAL RAISED · ON RECORD</Text>
      <Text style={styles.heroAmount} numberOfLines={1} adjustsFontSizeToFit>
        {fmtKes(stats.totalRaised)}
      </Text>

      <View style={styles.heroDivider} />

      {isWideWeb ? (
        <View style={styles.heroStatsRow}>
          <HeroStat value={fmtKes(stats.walletBalance)} label="Wallet balance" />
          <View style={styles.heroStatDivider} />
          <HeroStat value={String(stats.activeCampaigns)} label="Active campaigns" />
          <View style={styles.heroStatDivider} />
          <HeroStat value={String(stats.pendingDisbursements)} label="Pending payouts" />
        </View>
      ) : (
        <View style={styles.heroLedgerStack}>
          <HeroLedgerRow label="Wallet balance" value={fmtKes(stats.walletBalance)} />
          <HeroLedgerRow label="Active campaigns" value={String(stats.activeCampaigns)} />
          <HeroLedgerRow label="Pending payouts" value={String(stats.pendingDisbursements)} />
        </View>
      )}
    </LinearGradient>
  );
}

// ─── Donation row ─────────────────────────────────────────────────────────────

const DonationRow = React.memo(function DonationRow({ item }: { item: RecentDonation }) {
  return (
    <View style={styles.donationRow}>
      <View style={styles.donorAvatar}>
        <Text style={styles.donorAvatarText}>{donorInitials(item.donorName)}</Text>
      </View>
      <View style={styles.donationLeft}>
        <Text style={styles.donorName} numberOfLines={1}>
          {item.donorName ?? 'Anonymous'}
        </Text>
        <Text style={styles.donationCampaign} numberOfLines={1}>
          {item.campaignTitle}
        </Text>
        <Text style={styles.donationReceipt}>{item.mpesaReceipt}</Text>
      </View>
      <View style={styles.donationRight}>
        <Text style={styles.donationAmount}>+{fmtKes(item.netAmount)}</Text>{/* Net per Net-Everywhere rule */}
        <Text style={styles.donationTime}>{timeAgo(item.createdAt)}</Text>
      </View>
    </View>
  );
});

// ─── Campaign quick card ──────────────────────────────────────────────────────

const CampaignQuickCard = React.memo(function CampaignQuickCard({
  item,
  wide = false,
}: {
  item: TreasurerCampaign;
  /** Visual-only: full-width row variant for the wide-web column layout. */
  wide?: boolean;
}) {
  return (
    <View style={[styles.campaignCard, wide && styles.campaignCardWide]}>
      {item.groupLabelName ? (
        <View style={styles.groupBadge}>
          <Text style={styles.groupBadgeText}>{item.groupLabelName}</Text>
        </View>
      ) : null}
      <Text style={styles.campaignCardTitle} numberOfLines={2}>
        {item.title}
      </Text>
      <View style={styles.campaignProgress}>
        <ProgressBar
          raised={item.walletBalance}
          goal={item.goalAmount}
          height={6}
          showLabels={false}
        />
      </View>
      <Text style={styles.campaignRaised}>{fmtKes(item.walletBalance)}</Text>
      <Text style={styles.campaignGoal}>of {fmtKes(item.goalAmount)} goal</Text>
    </View>
  );
});

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({
  title,
  linkLabel = 'See all',
  onPress,
}: {
  title: string;
  linkLabel?: string;
  onPress?: () => void;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {onPress ? (
        <TouchableOpacity
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={linkLabel}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <View style={styles.seeAllRow}>
            <Text style={styles.seeAll}>{linkLabel}</Text>
            <Ionicons name="arrow-forward" size={13} color={Colors.primary} />
          </View>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

// ─── Overview screen ─────────────────────────────────────────────────────────

export default function OverviewScreen() {
  const router = useRouter();
  const isWideWeb = useIsWideWeb();
  const { unreadCount, setUnreadCount } = useNotifications();
  const { user } = useAuth();

  // B3: registration collects no person names → firstName may be '' for newly
  // registered churches. Greet WITHOUT a trailing ", " in that case. churchName
  // (top bar) comes from /auth/me and is reliable.
  const firstName = user?.firstName?.trim();

  // Stats (hero card + pending banner + recent-donations feed) — authed GET
  // /churches/me/stats/ — and the active-campaigns quick view — independent authed
  // GET /campaigns/mine/. Both refetch on every screen FOCUS (shared hook): first
  // focus shows the spinner, every return refetches in the BACKGROUND with
  // keep-last-good semantics (a failed background refresh never blanks the screen).
  const {
    data: stats,
    status: statsState,
    retry: retryStats,
  } = useFocusRefetch(() => dashboardService.getStats());

  const {
    data: allCampaigns,
    status: campaignsState,
    retry: retryCampaigns,
  } = useFocusRefetch(() => campaignsService.listMine());

  const campaigns = useMemo(
    () => (allCampaigns ?? []).filter(c => c.status === 'ACTIVE'),
    [allCampaigns],
  );

  // Pull-to-refresh: RefreshControl owns its own spinner; both retries run as
  // background refetches (data present), so nothing else flashes.
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([retryStats(), retryCampaigns()]);
    } finally {
      setRefreshing(false);
    }
  }, [retryStats, retryCampaigns]);

  // Whether each fetch currently holds data — read inside the poll tick without
  // being effect deps. Polling a section that has NO data yet would run retry() as
  // a FOREGROUND fetch and flash the full-screen spinner every tick; skip it instead
  // (the manual Try-again control owns that path).
  const hasStatsRef = useRef(false);
  hasStatsRef.current = stats !== null;
  const hasCampaignsRef = useRef(false);
  hasCampaignsRef.current = allCampaigns !== null;

  // Focused polling (this screen ONLY): refresh every POLL_INTERVAL_MS, active only
  // while the screen is FOCUSED **and** the app is FOREGROUNDED — both conditions,
  // because a blurred tab or a backgrounded app would otherwise keep burning battery,
  // data, and backend requests for a dashboard nobody is looking at. The interval is
  // cleared on blur (useFocusEffect cleanup) and on background (AppState listener).
  // Errors are silent by construction: retry() with data present is a background
  // refetch — last-good data stays on screen, no spinner, no toast.
  useFocusEffect(
    useCallback(() => {
      let timer: ReturnType<typeof setInterval> | null = null;
      const start = () => {
        if (timer) return;
        if (__DEV__) console.log('[overview-poll] started');
        timer = setInterval(() => {
          if (hasStatsRef.current) retryStats();
          if (hasCampaignsRef.current) retryCampaigns();
        }, POLL_INTERVAL_MS);
      };
      const stop = () => {
        if (!timer) return;
        if (__DEV__) console.log('[overview-poll] stopped');
        clearInterval(timer);
        timer = null;
      };
      if (AppState.currentState === 'active') start();
      const sub = AppState.addEventListener('change', s => {
        if (s === 'active') start();
        else stop();
      });
      return () => { stop(); sub.remove(); };
    }, [retryStats, retryCampaigns]),
  );

  // Bell unread count (Slice 2b, A-plain): refetch on Overview focus — useFocusEffect
  // fires on the FIRST focus (initial mount-focus, so a fresh login shows the real
  // count without leaving) AND on every return to Overview. No shared-store poke from
  // the notifications screen's list actions; a brief lag vs the list is expected. On
  // failure, keep the last known count (do NOT reset to 0 mid-session — a transient
  // error must not blank the badge).
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const { count } = await notificationsService.getUnreadCount();
          if (!cancelled) setUnreadCount(count);
        } catch {
          // transient — leave the last known count in place
        }
      })();
      return () => { cancelled = true; };
    }, [setUnreadCount]),
  );

  function goToNotifications() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.push('/(treasurer)/notifications' as any);
  }

  function goToPayouts() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.navigate('/(treasurer)/payouts' as any);
  }

  function goToCampaigns() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.navigate('/(treasurer)/campaigns' as any);
  }

  // Shared section blocks (rendered once, placed by width below).

  const donationsCard = stats ? (
    <View style={styles.card}>
      <SectionHeader title="Recent Donations" linkLabel="See all" />
      {stats.recentDonations.length === 0 ? (
        <View style={styles.emptyFeed}>
          <View style={styles.emptyFeedIcon}>
            <Ionicons name="heart-outline" size={22} color={Colors.primary} />
          </View>
          <Text style={styles.emptyInline}>
            No donations yet — share a campaign to get started.
          </Text>
        </View>
      ) : (
        stats.recentDonations.map((item, index) => (
          // Receipt is NOT guaranteed unique (a sandbox can repeat a receipt
          // across rows), so the key is receipt + index — mirrors reports.tsx.
          <React.Fragment key={`${item.mpesaReceipt}-${index}`}>
            <DonationRow item={item} />
            {index < stats.recentDonations.length - 1 ? (
              <View style={styles.divider} />
            ) : null}
          </React.Fragment>
        ))
      )}
    </View>
  ) : null;

  const campaignsCard = (
    <View style={[styles.card, !isWideWeb && styles.cardNoPadBottom]}>
      <SectionHeader
        title="Your Campaigns"
        linkLabel="Manage"
        onPress={goToCampaigns}
      />
      {campaignsState === 'loading' ? (
        <View style={styles.centerInline}>
          <ActivityIndicator size="small" color={Colors.primary} />
        </View>
      ) : campaignsState === 'error' ? (
        <View style={styles.centerInline}>
          <Text style={styles.emptyInline}>Couldn’t load campaigns.</Text>
          <TouchableOpacity
            onPress={retryCampaigns}
            accessibilityRole="button"
            accessibilityLabel="Retry campaigns"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.retryInlineText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : campaigns.length === 0 ? (
        <View style={styles.emptyFeed}>
          <View style={styles.emptyFeedIcon}>
            <Ionicons name="megaphone-outline" size={22} color={Colors.primary} />
          </View>
          <Text style={styles.emptyInline}>No active campaigns</Text>
        </View>
      ) : isWideWeb ? (
        // Wide web: vertical stack in the right column
        <View style={styles.campaignsColumn}>
          {campaigns.map((item) => (
            <CampaignQuickCard key={item.id} item={item} wide />
          ))}
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.campaignsScroll}
        >
          {campaigns.map((item) => (
            <CampaignQuickCard key={item.id} item={item} />
          ))}
        </ScrollView>
      )}
    </View>
  );

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, isWideWeb && styles.wideCap]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.primary}
            colors={[Colors.primary]}
          />
        }
      >
        {/* ── Greeting + notifications bell ── */}
        <View style={styles.greetingRow}>
          <View style={styles.greetingBlock}>
            <Text style={styles.greeting} numberOfLines={1}>
              {getGreeting()}{firstName ? `, ${firstName}` : ''}
            </Text>
            <Text style={styles.greetingDate}>{todayLine()}</Text>
          </View>
          <TouchableOpacity
            style={styles.bellBtn}
            onPress={goToNotifications}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`Notifications, ${unreadCount} unread`}
          >
            <Ionicons name="notifications-outline" size={22} color={Colors.primary} />
            {unreadCount > 0 ? (
              <View style={styles.bellBadge}>
                <Text style={styles.bellBadgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
              </View>
            ) : null}
          </TouchableOpacity>
        </View>

        {/* ── 1. Hero money card + 2. pending banner + 3. sections ── */}
        {statsState === 'loading' ? (
          <View style={styles.centerBlock}>
            <ActivityIndicator size="large" color={Colors.primary} />
          </View>
        ) : statsState === 'error' ? (
          <View style={styles.errorBlock}>
            <View style={styles.errorIconCircle}>
              <Ionicons name="cloud-offline-outline" size={30} color={Colors.primary} />
            </View>
            <Text style={styles.errorText}>Couldn’t load your dashboard.</Text>
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={retryStats}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Try again"
            >
              <Text style={styles.retryBtnText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : stats ? (
          <>
            <MoneyHeroCard stats={stats} />

            {stats.pendingDisbursements > 0 ? (
              <TouchableOpacity
                style={styles.alertBanner}
                onPress={goToPayouts}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={`${stats.pendingDisbursements} payout requests need approval. Tap to review.`}
              >
                <View style={styles.alertIconCircle}>
                  <Ionicons name="alert" size={16} color={Colors.white} />
                </View>
                <Text style={styles.alertText}>
                  {stats.pendingDisbursements} payout request
                  {stats.pendingDisbursements !== 1 ? 's' : ''} need your approval
                </Text>
                <Ionicons name="chevron-forward" size={18} color={Colors.accentDark} />
              </TouchableOpacity>
            ) : null}

            {isWideWeb ? (
              // Wide web: activity feed and campaigns side by side
              <View style={styles.wideColumns}>
                <View style={styles.wideColMain}>{donationsCard}</View>
                <View style={styles.wideColSide}>{campaignsCard}</View>
              </View>
            ) : (
              <>
                {donationsCard}
                {campaignsCard}
              </>
            )}
          </>
        ) : null}

        {/* Campaigns still render (own fetch) if stats failed on phone */}
        {statsState !== 'ok' && !isWideWeb ? campaignsCard : null}
        {statsState !== 'ok' && isWideWeb ? (
          <View style={styles.wideColumns}>
            <View style={styles.wideColSide}>{campaignsCard}</View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.white,
  },

  // Greeting
  greetingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  greetingBlock: {
    flex: 1,
    marginRight: Spacing.sm,
  },
  greeting: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.xl,
    color: Colors.text,
    lineHeight: FontSize.xl * 1.35,
  },
  greetingDate: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 1,
  },
  bellBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    ...Shadows.sm,
  },
  bellBadge: {
    position: 'absolute',
    top: 2,
    right: 0,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    backgroundColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
    borderWidth: 1.5,
    borderColor: Colors.white,
  },
  bellBadgeText: {
    fontFamily: 'Poppins-Bold',
    fontSize: 9,
    color: Colors.white,
    lineHeight: 13,
  },

  // Scroll
  scroll: {
    flex: 1,
    backgroundColor: Colors.surfaceSubtle,
  },
  scrollContent: {
    padding: Spacing.md,
    gap: Spacing.md,
    paddingBottom: Spacing.xl,
  },
  wideCap: {
    maxWidth: 1100,
    width: '100%',
    alignSelf: 'center',
  },
  wideColumns: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
  },
  wideColMain: {
    flex: 1.45,
    minWidth: 0,
  },
  wideColSide: {
    flex: 1,
    minWidth: 0,
  },

  // Hero money card
  heroCard: {
    borderRadius: BorderRadius.xl + 4,
    padding: Spacing.lg,
    overflow: 'hidden',
    ...Shadows.lg,
  },
  heroOrnamentA: {
    position: 'absolute',
    top: -80,
    right: -60,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  heroOrnamentB: {
    position: 'absolute',
    bottom: -90,
    left: -70,
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  heroEyebrow: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: 10,
    letterSpacing: 1.4,
    color: 'rgba(255,255,255,0.75)',
    marginBottom: 6,
  },
  heroAmount: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.title,
    color: Colors.white,
    lineHeight: FontSize.title * 1.25,
  },
  heroDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.18)',
    marginVertical: Spacing.md,
  },
  heroStatsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  heroStat: {
    flex: 1,
    minWidth: 0,
  },
  heroStatValue: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.base,
    color: Colors.white,
    lineHeight: FontSize.base * 1.4,
  },
  heroStatLabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: 11,
    color: 'rgba(255,255,255,0.72)',
    marginTop: 1,
  },
  heroStatDivider: {
    width: 1,
    height: 30,
    backgroundColor: 'rgba(255,255,255,0.18)',
    marginHorizontal: Spacing.md,
  },
  heroLedgerStack: {
    gap: 6,
  },
  heroLedgerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  heroLedgerValue: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.base,
    color: Colors.white,
    flexShrink: 0,
  },

  // Loading / error / empty (dashboard)
  centerBlock: {
    paddingVertical: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorBlock: {
    paddingVertical: 40,
    alignItems: 'center',
    gap: Spacing.sm,
  },
  errorIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 4,
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
  emptyInline: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  emptyFeed: {
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.lg,
  },
  emptyFeedIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerInline: {
    paddingVertical: Spacing.md,
    alignItems: 'center',
    gap: 6,
  },
  retryInlineText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },

  // Alert banner
  alertBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm + 2,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.accentLight,
    paddingVertical: Spacing.sm + 4,
    paddingHorizontal: Spacing.md,
  },
  alertIconCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  alertText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.accentDark,
    flex: 1,
  },

  // Cards (sections)
  card: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.xl,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    ...Shadows.sm,
  },
  cardNoPadBottom: {
    paddingBottom: Spacing.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sectionTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.base,
    color: Colors.text,
  },
  seeAllRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  seeAll: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },

  // Donation rows
  donationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: Spacing.sm + 2,
  },
  donorAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  donorAvatarText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xs,
    color: Colors.primary,
  },
  donationLeft: {
    flex: 1,
    marginRight: Spacing.sm,
    minWidth: 0,
  },
  donorName: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.text,
  },
  donationCampaign: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 1,
  },
  donationReceipt: {
    fontFamily: 'Poppins-Regular',
    fontSize: 10,
    color: Colors.textMuted,
    opacity: 0.7,
    marginTop: 2,
    letterSpacing: 0.6,
  },
  donationRight: {
    alignItems: 'flex-end',
  },
  donationAmount: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.primary,
  },
  donationTime: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.borderLight,
    marginLeft: 38 + Spacing.sm + 2,
  },

  // Campaign quick cards
  campaignsScroll: {
    paddingBottom: Spacing.sm,
    paddingRight: Spacing.xs,
  },
  campaignsColumn: {
    gap: Spacing.sm + 2,
  },
  campaignCard: {
    width: 220,
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    padding: Spacing.md,
    marginRight: 10,
    ...Shadows.sm,
  },
  campaignCardWide: {
    width: '100%',
    marginRight: 0,
  },
  groupBadge: {
    alignSelf: 'flex-start',
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginBottom: 6,
  },
  groupBadgeText: {
    fontFamily: 'Poppins-Medium',
    fontSize: 10,
    color: Colors.primaryDark,
  },
  campaignCardTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.text,
    lineHeight: 19,
    marginBottom: 10,
  },
  campaignProgress: {
    marginBottom: 6,
  },
  campaignRaised: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.primary,
    marginTop: 4,
  },
  campaignGoal: {
    fontFamily: 'Poppins-Regular',
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 1,
  },
});
