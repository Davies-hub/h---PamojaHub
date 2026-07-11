import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsWideWeb } from '../../components/layout/Screen';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { useFocusRefetch } from '../../hooks/useFocusRefetch';
import { superadminService } from '../../services/superadmin.service';
import { fmtKes } from '../../utils/formatters';

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon,
  iconColor,
  wide,
}: {
  label: string;
  value: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  iconColor: string;
  wide?: boolean;
}) {
  return (
    <View style={[styles.statCard, wide && styles.statCardWide]}>
      <View style={[styles.statIconWrap, { backgroundColor: iconColor + '20' }]}>
        <Ionicons name={icon} size={22} color={iconColor} />
      </View>
      <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ─── Chart helpers ────────────────────────────────────────────────────────────

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Compact KES for the cramped 12-bar monthly labels (e.g. 3.0k, 1.2M). The full
// fmtKes is used where there's room (horizontal church bars).
function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

const MONTHLY_MAX_BAR = 120;   // px — the tallest bar; every other scales to it

// ─── Donations by month — vertical bars (pure <View>, no chart lib) ────────────

function MonthlyBarsChart({ data }: { data: { month: string; total: number }[] }) {
  // reduce-with-0 seed → max is 0 (never NaN) for an empty array; every ratio is
  // guarded on max > 0 below, so there is no divide-by-zero.
  const max = data.reduce((m, d) => Math.max(m, d.total), 0);
  const allZero = max <= 0;

  return (
    <View style={styles.chartCard}>
      <Text style={styles.chartCardLabel}>Donations by Month</Text>
      {data.length === 0 ? (
        <View style={styles.chartEmpty}>
          <Text style={styles.chartEmptyText}>No donations yet</Text>
        </View>
      ) : (
        <View style={styles.chartBody}>
          <View style={styles.monthlyRow}>
            {data.map(d => {
              // Zero-total months sit flat on the baseline (height 0); non-zero
              // bars get at least 3px so a tiny value is still visible.
              const h = d.total > 0 && max > 0
                ? Math.max(3, Math.round((d.total / max) * MONTHLY_MAX_BAR))
                : 0;
              const mIdx = Number(d.month.slice(5, 7)) - 1;
              const label = MONTH_ABBR[mIdx] ?? d.month;
              return (
                <View key={d.month} style={styles.monthlyCol}>
                  <Text style={styles.monthlyValue} numberOfLines={1}>
                    {d.total > 0 ? fmtCompact(d.total) : ''}
                  </Text>
                  <View style={styles.monthlyTrack}>
                    <View style={[styles.monthlyBar, { height: h }]} />
                  </View>
                  <Text style={styles.monthlyLabel} numberOfLines={1}>{label}</Text>
                </View>
              );
            })}
          </View>
          {allZero && <Text style={styles.chartCaption}>No donations yet</Text>}
        </View>
      )}
    </View>
  );
}

// ─── Top 10 churches by raised — horizontal bars (pure <View>, no chart lib) ───

function TopChurchesBarsChart({ data }: { data: { churchName: string; totalRaised: number }[] }) {
  const max = data.reduce((m, d) => Math.max(m, d.totalRaised), 0);
  const allZero = max <= 0;

  return (
    <View style={styles.chartCard}>
      <Text style={styles.chartCardLabel}>Top 10 Churches by Raised</Text>
      {data.length === 0 ? (
        <View style={styles.chartEmpty}>
          <Text style={styles.chartEmptyText}>No church data yet</Text>
        </View>
      ) : (
        <View style={styles.chartBody}>
          {data.map((d, i) => {
            // Flex ratios (not %-width strings) → no NaN, no divide-by-zero, and a
            // single-item array fills the track (pct 100). Guarded on max > 0.
            const pct = d.totalRaised > 0 && max > 0
              ? Math.max(2, Math.round((d.totalRaised / max) * 100))
              : 0;
            return (
              <View key={`${d.churchName}-${i}`} style={styles.churchRow}>
                <View style={styles.churchHeader}>
                  <Text style={styles.churchName} numberOfLines={1}>{d.churchName}</Text>
                  <Text style={styles.churchValue}>{fmtKes(d.totalRaised)}</Text>
                </View>
                <View style={styles.churchTrack}>
                  <View style={[styles.churchBar, { flex: pct }]} />
                  {pct < 100 && <View style={{ flex: 100 - pct }} />}
                </View>
              </View>
            );
          })}
          {allZero && <Text style={styles.chartCaption}>No church data yet</Text>}
        </View>
      )}
    </View>
  );
}

// ─── Time range chip ──────────────────────────────────────────────────────────

type TimeRange = 'This Month' | 'Last 30 Days' | 'This Year' | 'All Time';
const TIME_RANGES: TimeRange[] = ['This Month', 'Last 30 Days', 'This Year', 'All Time'];

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function SuperAnalyticsScreen() {
  // timeRange stays INERT this slice — the endpoint accepts from/to params but
  // wiring date-filtering is its own later slice. Cosmetic UI only.
  const [timeRange, setTimeRange] = useState<TimeRange>('All Time');
  const isWideWeb = useIsWideWeb();

  // R2: background refetch-on-focus (shared hook). First focus shows the spinner;
  // every revisit refetches in the BACKGROUND (cards stay, no blank/flash). DISPLAY-
  // class — no local handler mutates this data, so we read the server's pre-aggregated
  // object straight from `data` (no mirror). The old client-side mock .reduce() is gone.
  const { data, status: aState, retry } = useFocusRefetch(
    () => superadminService.getAnalytics(),
  );

  return (
    <SafeAreaView edges={['bottom']} style={styles.root}>
      <ScrollView
        contentContainerStyle={[styles.content, isWideWeb && styles.wideContent]}
        showsVerticalScrollIndicator={false}
      >
        {/* Time range filter */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.rangeScroll}
        >
          {TIME_RANGES.map(r => (
            <TouchableOpacity
              key={r}
              style={[styles.rangeChip, timeRange === r && styles.rangeChipActive]}
              onPress={() => setTimeRange(r)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={r}
            >
              <Text style={[styles.rangeChipText, timeRange === r && styles.rangeChipTextActive]}>
                {r}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {aState === 'loading' ? (
          <View style={styles.centerBlock}>
            <ActivityIndicator size="large" color={Colors.primary} />
          </View>
        ) : aState === 'error' ? (
          <View style={styles.errorBlock}>
            <Ionicons name="cloud-offline-outline" size={40} color={Colors.border} />
            <Text style={styles.errorText}>Couldn’t load analytics.</Text>
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
        ) : data ? (
          <>
            {/* 2×2 stat grid — server aggregates */}
            <View style={styles.grid}>
              <StatCard
                label="Total Churches"
                value={String(data.totalChurches)}
                icon="business-outline"
                iconColor={Colors.primary}
                wide={isWideWeb}
              />
              <StatCard
                label="Active Campaigns"
                value={String(data.totalActiveCampaigns)}
                icon="grid-outline"
                iconColor={Colors.success}
                wide={isWideWeb}
              />
              <StatCard
                label="Total Donations"
                value={fmtKes(data.totalDonations)}
                icon="cash-outline"
                iconColor={Colors.accent}
                wide={isWideWeb}
              />
              <StatCard
                label="Platform Fees"
                value={fmtKes(data.totalPlatformFees)}
                icon="trending-up-outline"
                iconColor={Colors.primary}
                wide={isWideWeb}
              />
            </View>

            {/* Charts — pure <View> bars from the server aggregates */}
            <MonthlyBarsChart data={data.donationsByMonth} />
            <TopChurchesBarsChart data={data.topChurchesByRaised} />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.grey },
  content: {
    padding: Spacing.md,
    paddingBottom: Spacing.xl,
    gap: Spacing.md,
  },
  wideContent: {
    maxWidth: 1100,
    width: '100%',
    alignSelf: 'center',
  },

  // Loading / error (same pattern as S1–S5)
  centerBlock: { paddingVertical: 48, alignItems: 'center', justifyContent: 'center' },
  errorBlock: { paddingVertical: 40, alignItems: 'center', gap: Spacing.sm },
  errorText: { fontFamily: 'Poppins-Regular', fontSize: FontSize.md, color: Colors.textMuted, textAlign: 'center' },
  retryBtn: {
    marginTop: 4,
    paddingHorizontal: Spacing.lg,
    height: Spacing.touch,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryBtnText: { fontFamily: 'Poppins-SemiBold', fontSize: FontSize.md, color: Colors.white },

  rangeScroll: { gap: 8, paddingBottom: 4 },
  rangeChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
  },
  rangeChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  rangeChipText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  rangeChipTextActive: { color: Colors.white },

  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  statCard: {
    width: '48%',
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    gap: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  statCardWide: {
    width: undefined,
    flexBasis: '23%',
  },
  statIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statValue: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.text,
  },
  statLabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },

  chartCard: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.primaryLight,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  chartCardLabel: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.base,
    color: Colors.text,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.primaryLight,
  },

  // Shared chart body + empty/caption states
  chartBody: {
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  chartEmpty: {
    height: 160,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chartEmptyText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  chartCaption: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textAlign: 'center',
    marginTop: 4,
  },

  // Donations by month — vertical bars
  monthlyRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  monthlyCol: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  monthlyValue: {
    fontFamily: 'Poppins-Medium',
    fontSize: 8,
    color: Colors.textSecondary,
    height: 12,
  },
  monthlyTrack: {
    height: MONTHLY_MAX_BAR,
    width: '100%',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  monthlyBar: {
    width: '62%',
    minWidth: 6,
    backgroundColor: Colors.accent,
    borderTopLeftRadius: BorderRadius.sm,
    borderTopRightRadius: BorderRadius.sm,
  },
  monthlyLabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: 9,
    color: Colors.textMuted,
  },

  // Top churches — horizontal bars
  churchRow: {
    gap: 4,
  },
  churchHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  churchName: {
    flex: 1,
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  churchValue: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  churchTrack: {
    flexDirection: 'row',
    height: 10,
    backgroundColor: Colors.progressTrack,
    borderRadius: BorderRadius.sm,
    overflow: 'hidden',
  },
  churchBar: {
    backgroundColor: Colors.accent,
    borderRadius: BorderRadius.sm,
  },
});
