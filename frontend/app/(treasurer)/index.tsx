import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import ProgressBar from '../../components/ui/ProgressBar';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { campaignsService } from '../../services/campaigns.service';
import { dashboardService } from '../../services/dashboard.service';
import { notificationsService } from '../../services/notifications.service';
import { DashboardStats, RecentDonation, TreasurerCampaign } from '../../types';
import { useAuth } from '../../stores/auth.store';
import { useNotifications } from '../../stores/notifications.store';

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

// ─── Summary card ─────────────────────────────────────────────────────────────

interface SummaryCardProps {
  label: string;
  value: string;
  variant?: 'default' | 'danger';
}

function SummaryCard({ label, value, variant = 'default' }: SummaryCardProps) {
  const danger = variant === 'danger';
  return (
    <View style={[styles.summaryCard, danger && styles.summaryCardDanger]}>
      <Text
        style={[styles.summaryValue, danger && styles.summaryValueDanger]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value}
      </Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

// ─── Donation row ─────────────────────────────────────────────────────────────

const DonationRow = React.memo(function DonationRow({ item }: { item: RecentDonation }) {
  return (
    <View style={styles.donationRow}>
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
}: {
  item: TreasurerCampaign;
}) {
  return (
    <View style={styles.campaignCard}>
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
          height={4}
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
      <TouchableOpacity
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={linkLabel}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Text style={styles.seeAll}>{linkLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Overview screen ─────────────────────────────────────────────────────────

export default function OverviewScreen() {
  const router = useRouter();
  const { unreadCount, setUnreadCount } = useNotifications();
  const { user } = useAuth();

  // B3: registration collects no person names → firstName may be '' for newly
  // registered churches. Greet WITHOUT a trailing ", " in that case. churchName
  // (top bar) comes from /auth/me and is reliable.
  const firstName = user?.firstName?.trim();

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [statsState, setStatsState] = useState<'loading' | 'error' | 'ok'>('loading');
  const [statsReload, setStatsReload] = useState(0);

  const [campaigns, setCampaigns] = useState<TreasurerCampaign[]>([]);
  const [campaignsState, setCampaignsState] = useState<'loading' | 'error' | 'ok'>('loading');
  const [campaignsReload, setCampaignsReload] = useState(0);

  // Stats (the 4 cards + recent-donations feed) — authed GET /churches/me/stats/.
  useEffect(() => {
    let cancelled = false;
    setStatsState('loading');
    (async () => {
      try {
        const data = await dashboardService.getStats();
        if (!cancelled) { setStats(data); setStatsState('ok'); }
      } catch {
        if (!cancelled) setStatsState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [statsReload]);

  // Active campaigns quick view — independent authed GET /campaigns/mine/.
  useEffect(() => {
    let cancelled = false;
    setCampaignsState('loading');
    (async () => {
      try {
        const data = await campaignsService.listMine();
        if (!cancelled) { setCampaigns(data.filter(c => c.status === 'ACTIVE')); setCampaignsState('ok'); }
      } catch {
        if (!cancelled) setCampaignsState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [campaignsReload]);

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

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Greeting + notifications bell ── */}
        <View style={styles.greetingRow}>
          <Text style={styles.greeting} numberOfLines={1}>
            {getGreeting()}{firstName ? `, ${firstName}` : ''}
          </Text>
          <TouchableOpacity
            style={styles.bellBtn}
            onPress={goToNotifications}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`Notifications, ${unreadCount} unread`}
          >
            <Ionicons name="notifications-outline" size={24} color={Colors.primary} />
            {unreadCount > 0 ? (
              <View style={styles.bellBadge}>
                <Text style={styles.bellBadgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
              </View>
            ) : null}
          </TouchableOpacity>
        </View>

        {/* ── 1. Summary grid + 2. pending banner + 3. recent donations (all from stats) ── */}
        {statsState === 'loading' ? (
          <View style={styles.centerBlock}>
            <ActivityIndicator size="large" color={Colors.primary} />
          </View>
        ) : statsState === 'error' ? (
          <View style={styles.errorBlock}>
            <Ionicons name="cloud-offline-outline" size={40} color={Colors.border} />
            <Text style={styles.errorText}>Couldn’t load your dashboard.</Text>
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={() => setStatsReload(k => k + 1)}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Try again"
            >
              <Text style={styles.retryBtnText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : stats ? (
          <>
            <View style={styles.summaryGrid}>
              <View style={styles.summaryRow}>
                <SummaryCard value={fmtKes(stats.totalRaised)} label="Total Raised" />
                <SummaryCard value={fmtKes(stats.walletBalance)} label="Wallet Balance" />
              </View>
              <View style={styles.summaryRow}>
                <SummaryCard value={String(stats.activeCampaigns)} label="Active Campaigns" />
                <SummaryCard
                  value={String(stats.pendingDisbursements)}
                  label="Pending Payouts"
                  variant={stats.pendingDisbursements > 0 ? 'danger' : 'default'}
                />
              </View>
            </View>

            {stats.pendingDisbursements > 0 ? (
              <TouchableOpacity
                style={styles.alertBanner}
                onPress={goToPayouts}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={`${stats.pendingDisbursements} payout requests need approval. Tap to review.`}
              >
                <View style={styles.alertAccent} />
                <View style={styles.alertBody}>
                  <Text style={styles.alertText}>
                    {stats.pendingDisbursements} payout request
                    {stats.pendingDisbursements !== 1 ? 's' : ''} need your approval
                  </Text>
                  <Ionicons name="chevron-forward" size={18} color={Colors.accent} />
                </View>
              </TouchableOpacity>
            ) : null}

            <View style={styles.card}>
              <SectionHeader title="Recent Donations" linkLabel="See all" />
              {stats.recentDonations.length === 0 ? (
                <Text style={styles.emptyInline}>No donations yet</Text>
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
          </>
        ) : null}

        {/* ── 4. Active campaigns quick view (independent fetch) ── */}
        <View style={[styles.card, styles.cardNoPadBottom]}>
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
                onPress={() => setCampaignsReload(k => k + 1)}
                accessibilityRole="button"
                accessibilityLabel="Retry campaigns"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.retryInlineText}>Try again</Text>
              </TouchableOpacity>
            </View>
          ) : campaigns.length === 0 ? (
            <Text style={styles.emptyInline}>No active campaigns</Text>
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
  greeting: {
    flex: 1,
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
    marginRight: Spacing.sm,
  },
  bellBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  bellBadge: {
    position: 'absolute',
    top: 4,
    right: 2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  bellBadgeText: {
    fontFamily: 'Poppins-Bold',
    fontSize: 9,
    color: Colors.white,
    lineHeight: 14,
  },

  // Scroll
  scroll: {
    flex: 1,
    backgroundColor: Colors.grey,
  },
  scrollContent: {
    padding: Spacing.md,
    gap: Spacing.md,
    paddingBottom: Spacing.xl,
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
  errorText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 4,
    paddingHorizontal: Spacing.lg,
    height: Spacing.touch,
    borderRadius: BorderRadius.md,
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
    paddingVertical: Spacing.md,
    textAlign: 'center',
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

  // Summary grid
  summaryGrid: {
    gap: 10,
  },
  summaryRow: {
    flexDirection: 'row',
    gap: 10,
  },
  summaryCard: {
    flex: 1,
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  summaryCardDanger: {
    backgroundColor: Colors.dangerLight,
    borderColor: Colors.dangerLight,
  },
  summaryValue: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxl,
    color: Colors.primary,
    marginBottom: 4,
  },
  summaryValueDanger: {
    color: Colors.danger,
  },
  summaryLabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },

  // Alert banner
  alertBanner: {
    flexDirection: 'row',
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.accentLight,
    overflow: 'hidden',
  },
  alertAccent: {
    width: 4,
    backgroundColor: Colors.accent,
    alignSelf: 'stretch',
  },
  alertBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    paddingHorizontal: Spacing.md,
  },
  alertText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.accentDark,
    flex: 1,
    marginRight: Spacing.sm,
  },

  // Cards (sections)
  card: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
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
    fontSize: FontSize.md,
    color: Colors.text,
  },
  seeAll: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },

  // Donation rows
  donationRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
  },
  donationLeft: {
    flex: 1,
    marginRight: Spacing.md,
  },
  donorName: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.md,
    color: Colors.text,
  },
  donationCampaign: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 2,
  },
  donationReceipt: {
    fontFamily: 'Poppins-Regular',
    fontSize: 11,
    color: Colors.border,
    marginTop: 3,
    letterSpacing: 0.4,
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
    backgroundColor: Colors.grey,
  },

  // Campaign quick cards
  campaignsScroll: {
    paddingBottom: Spacing.sm,
    paddingRight: Spacing.xs,
  },
  campaignCard: {
    width: 210,
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginRight: 10,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
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
    color: Colors.primary,
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
  campaignDivider: {
    height: 1,
    backgroundColor: Colors.grey,
    marginVertical: 10,
  },
  walletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  walletLabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  walletAmount: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.success,
  },
});
