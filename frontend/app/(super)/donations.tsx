import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsWideWeb } from '../../components/layout/Screen';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { useFocusRefetch } from '../../hooks/useFocusRefetch';
import { superadminService } from '../../services/superadmin.service';
import { Donation, DonationStatus } from '../../types';
import { fmtKes, formatDateTime } from '../../utils/formatters';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type FilterStatus = DonationStatus | 'ALL';
type DateFilter   = 'ALL_TIME' | 'TODAY' | 'THIS_WEEK' | 'THIS_MONTH';

const STATUS_BADGE: Record<DonationStatus, { bg: string; text: string }> = {
  SUCCESSFUL: { bg: Colors.successLight, text: Colors.success },
  FAILED:     { bg: Colors.dangerLight,  text: Colors.danger },
  PENDING:    { bg: Colors.warningLight, text: Colors.warning },
};

const STATUS_LABELS: Record<FilterStatus, string> = {
  ALL:        'All',
  SUCCESSFUL: 'Successful',
  FAILED:     'Failed',
  PENDING:    'Pending',
};

const STATUS_ORDER: FilterStatus[] = ['ALL', 'SUCCESSFUL', 'FAILED', 'PENDING'];

const DATE_OPTIONS: { key: DateFilter; label: string }[] = [
  { key: 'ALL_TIME',   label: 'All Time' },
  { key: 'TODAY',      label: 'Today' },
  { key: 'THIS_WEEK',  label: 'This Week' },
  { key: 'THIS_MONTH', label: 'This Month' },
];

function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function isInDateRange(dateStr: string, filter: DateFilter): boolean {
  const ts = new Date(dateStr).getTime();
  if (filter === 'ALL_TIME') return true;
  if (filter === 'TODAY') {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return ts >= start.getTime();
  }
  if (filter === 'THIS_WEEK') return ts >= Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (filter === 'THIS_MONTH') {
    const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
    return ts >= start.getTime();
  }
  return true;
}

// ─── Donation row ─────────────────────────────────────────────────────────────

function DonationRow({ item }: { item: Donation }) {
  const { bg, text } = STATUS_BADGE[item.status];

  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <View style={styles.rowLeft}>
          <Text style={styles.receiptNum}>
            {item.mpesaReceiptNumber ?? 'No receipt'}
          </Text>
          <Text style={styles.campaignTitle} numberOfLines={1}>{item.campaignTitle}</Text>
          <Text style={styles.churchName} numberOfLines={1}>{item.churchName ?? '—'}</Text>
        </View>
        <View style={styles.rowRight}>
          <View style={[styles.statusBadge, { backgroundColor: bg }]}>
            <Text style={[styles.statusText, { color: text }]}>{STATUS_LABELS[item.status]}</Text>
          </View>
          <Text style={styles.rowDate}>{formatDateTime(item.createdAt)}</Text>
        </View>
      </View>

      <View style={styles.donorRow}>
        <Ionicons name="person-outline" size={11} color={Colors.textMuted} />
        <Text style={styles.donorName}>{item.donorName ?? 'Anonymous'}</Text>
      </View>

      <View style={styles.amountGrid}>
        <View style={styles.amountCell}>
          <Text style={styles.amountLabel}>Gross</Text>
          <Text style={styles.amountValue}>{fmtKes(item.amount)}</Text>
        </View>
        <View style={styles.amountDivider} />
        <View style={styles.amountCell}>
          <Text style={styles.amountLabel}>Platform Fee</Text>
          {/* D2: null until the STK callback computes it — show a dash, never KES 0 */}
          <Text style={[styles.amountValue, styles.feeValue]}>
            {item.platformFee == null ? '—' : fmtKes(item.platformFee)}
          </Text>
        </View>
        <View style={styles.amountDivider} />
        <View style={styles.amountCell}>
          <Text style={styles.amountLabel}>Net</Text>
          {/* D2: null until the STK callback computes it — show a dash, never KES 0 */}
          <Text style={[styles.amountValue, styles.netValue]}>
            {item.netAmount == null ? '—' : fmtKes(item.netAmount)}
          </Text>
        </View>
      </View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function SuperDonationsScreen() {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('ALL');
  const [dateFilter, setDateFilter]     = useState<DateFilter>('ALL_TIME');
  const [search, setSearch]             = useState('');

  // R2: background refetch-on-focus (shared hook). First focus = spinner; every
  // revisit refetches in the BACKGROUND (list stays, no blank/flash). DISPLAY-class
  // (no handler mutates the list) → derive the view straight from `data`, no mirror.
  // Still consumes the D5 Paginated shape; mapDonation keeps null fee/net as null
  // (D2 — rendered as "—", never 0) and drops the sensitive keys.
  const { data, status: dState, retry } = useFocusRefetch(
    () => superadminService.listDonations(),
  );
  const donations = data?.items ?? [];
  const total     = data?.total ?? 0;
  const truncated = data?.truncated ?? false;

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        router.navigate('/(super)/more' as any);
        return true;
      });
      return () => sub.remove();
    }, [router])
  );

  const filtered = useMemo(() => {
    return donations.filter(d => {
      if (statusFilter !== 'ALL' && d.status !== statusFilter) return false;
      if (!isInDateRange(d.createdAt, dateFilter)) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        const matchChurch   = (d.churchName ?? '').toLowerCase().includes(q);
        const matchCampaign = d.campaignTitle.toLowerCase().includes(q);
        const matchDonor    = (d.donorName ?? '').toLowerCase().includes(q);
        const matchReceipt  = (d.mpesaReceiptNumber ?? '').toLowerCase().includes(q);
        if (!matchChurch && !matchCampaign && !matchDonor && !matchReceipt) return false;
      }
      return true;
    });
  }, [donations, statusFilter, dateFilter, search]);

  const isWideWeb = useIsWideWeb();

  return (
    <SafeAreaView edges={['bottom']} style={styles.root}>
      {/* Back bar */}
      <View style={[styles.backBar, isWideWeb && styles.wideColumn]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.navigate('/(super)/more' as any)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Go back to More"
        >
          <Ionicons name="arrow-back" size={22} color={Colors.primary} />
          <Text style={styles.backBtnText}>More</Text>
        </TouchableOpacity>
        <Text style={styles.backBarTitle}>Donations</Text>
        <View style={styles.backBarSpacer} />
      </View>
      <View style={[styles.filterBar, isWideWeb && styles.wideColumn]}>
        <View style={styles.searchRow}>
          <Ionicons name="search-outline" size={14} color={Colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search church, campaign, receipt…"
            placeholderTextColor={Colors.textMuted}
            value={search}
            onChangeText={setSearch}
            accessibilityLabel="Search donations"
          />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsScroll}
        >
          {STATUS_ORDER.map(s => (
            <FilterChip
              key={s}
              label={STATUS_LABELS[s]}
              active={statusFilter === s}
              onPress={() => setStatusFilter(s)}
            />
          ))}
          <View style={styles.chipDivider} />
          {DATE_OPTIONS.map(d => (
            <FilterChip
              key={d.key}
              label={d.label}
              active={dateFilter === d.key}
              onPress={() => setDateFilter(d.key)}
            />
          ))}
        </ScrollView>
      </View>

      {dState === 'loading' ? (
        <View style={[styles.centerBlock, isWideWeb && styles.wideColumn]}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : dState === 'error' ? (
        <View style={[styles.errorBlock, isWideWeb && styles.wideColumn]}>
          <Ionicons name="cloud-offline-outline" size={40} color={Colors.border} />
          <Text style={styles.errorText}>Couldn’t load donations.</Text>
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
      ) : (
        <>
          {truncated ? (
            <View style={[styles.truncBanner, isWideWeb && styles.wideColumn]}>
              <Ionicons name="information-circle-outline" size={15} color={Colors.warning} />
              <Text style={styles.truncText}>Showing first {donations.length} of {total}.</Text>
            </View>
          ) : null}
          <FlatList
            data={filtered}
            keyExtractor={item => item.id}
            renderItem={({ item }) => <DonationRow item={item} />}
            contentContainerStyle={[styles.listContent, isWideWeb && styles.wideColumn]}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Ionicons name="cash-outline" size={48} color={Colors.border} />
                <Text style={styles.emptyTitle}>No donations found</Text>
              </View>
            }
          />
        </>
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.grey },

  // Wide-web (≥768) only — list content and its outside-the-list siblings share
  // one centered 760 column.
  wideColumn: {
    maxWidth: 760,
    width: '100%',
    alignSelf: 'center',
  },

  // Loading / error (same pattern as S1 billing + the wired treasurer reads)
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

  // D5 truncation notice (warning tokens) — a NOTICE only, never paging controls.
  truncBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.warningLight,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
  },
  truncText: { fontFamily: 'Poppins-Medium', fontSize: FontSize.xs, color: Colors.warning },

  backBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    paddingHorizontal: Spacing.md,
    height: 48,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    width: 72,
  },
  backBtnText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.base,
    color: Colors.primary,
  },
  backBarTitle: {
    flex: 1,
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
    textAlign: 'center',
  },
  backBarSpacer: { width: 72 },

  filterBar: {
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    paddingBottom: 8,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: Spacing.md,
    marginBottom: 8,
    paddingHorizontal: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    height: 40,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.text,
    height: '100%',
  },
  chipsScroll: { paddingHorizontal: Spacing.md, gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontFamily: 'Poppins-Medium', fontSize: FontSize.xs, color: Colors.textSecondary },
  chipTextActive: { color: Colors.white },
  chipDivider: { width: 1, backgroundColor: Colors.border, marginHorizontal: 4 },

  listContent: { padding: Spacing.md, paddingBottom: Spacing.xl },
  separator: { height: Spacing.sm },

  row: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    gap: Spacing.sm,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  rowLeft: { flex: 1, gap: 2 },
  receiptNum: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.sm,
    color: Colors.text,
    letterSpacing: 0.5,
  },
  campaignTitle: { fontFamily: 'Poppins-Regular', fontSize: FontSize.sm, color: Colors.textSecondary },
  churchName: { fontFamily: 'Poppins-Regular', fontSize: FontSize.xs, color: Colors.primary },
  rowRight: { alignItems: 'flex-end', gap: 4, flexShrink: 0 },
  statusBadge: { borderRadius: BorderRadius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { fontFamily: 'Poppins-Medium', fontSize: 10 },
  rowDate: { fontFamily: 'Poppins-Regular', fontSize: 10, color: Colors.textMuted },

  donorRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  donorName: { fontFamily: 'Poppins-Regular', fontSize: FontSize.xs, color: Colors.textMuted },

  amountGrid: {
    flexDirection: 'row',
    backgroundColor: Colors.grey,
    borderRadius: BorderRadius.sm,
    overflow: 'hidden',
  },
  amountCell: { flex: 1, alignItems: 'center', paddingVertical: Spacing.sm, gap: 2 },
  amountDivider: { width: 1, backgroundColor: Colors.border },
  amountLabel: { fontFamily: 'Poppins-Regular', fontSize: 10, color: Colors.textMuted },
  amountValue: { fontFamily: 'Poppins-SemiBold', fontSize: FontSize.sm, color: Colors.text },
  feeValue: { color: Colors.danger },
  netValue: { color: Colors.success },

  emptyState: { alignItems: 'center', paddingTop: 60, gap: Spacing.sm },
  emptyTitle: { fontFamily: 'Poppins-SemiBold', fontSize: FontSize.lg, color: Colors.text, marginTop: Spacing.sm },
});
