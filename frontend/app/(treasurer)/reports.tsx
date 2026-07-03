import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal as RNModal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { useFocusRefetch } from '../../hooks/useFocusRefetch';
import { campaignsService } from '../../services/campaigns.service';
import { churchesService } from '../../services/churches.service';
import { MyDonationRow } from '../../services/mappers';
import { withdrawalsService } from '../../services/withdrawals.service';
import { TreasurerCampaign, Withdrawal, WithdrawalStatus } from '../../types';
import { fmtKes, formatDate } from '../../utils/formatters';

// ─── Types ────────────────────────────────────────────────────────────────────

// audit_log DROPPED — there is no JWT treasurer audit endpoint (only /super/audit-log/,
// IsSuperAdmin), so it is removed entirely rather than stubbed.
type ReportType = 'campaign_summary' | 'donation_history' | 'payout_history';
type ReportFormat = 'CSV' | 'PDF';

interface ReportOption {
  id: ReportType;
  label: string;
  description: string;
  icon: keyof typeof Ionicons.glyphMap;
}

// The combined dataset fetched in one pass; the active report type just selects which
// slice to render (client-side), so switching types is instant with no refetch.
interface ReportData {
  campaigns: TreasurerCampaign[];
  donations: MyDonationRow[];   // server-side date-filtered (from/to); max 20 (page 1)
  donationsTotal: number;       // true total of matching donations across ALL pages
  payouts: Withdrawal[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const REPORT_OPTIONS: ReportOption[] = [
  {
    id: 'campaign_summary',
    label: 'Campaign Summary',
    description: 'Goals, raised, and wallet balance per campaign (all NET)',
    icon: 'grid-outline',
  },
  {
    id: 'donation_history',
    label: 'Donation History',
    description: 'Successful donations with M-Pesa receipts (NET amounts)',
    icon: 'cash-outline',
  },
  {
    id: 'payout_history',
    label: 'Payout History',
    description: 'All payout requests and their outcomes (NET)',
    icon: 'arrow-up-circle-outline',
  },
];

const ALL_GROUPS = 'All Groups';

const WITHDRAWAL_STATUS_LABEL: Record<WithdrawalStatus, string> = {
  PENDING_APPROVAL: 'Pending',
  PROCESSING: 'Processing',
  PAID: 'Paid',
  FAILED: 'Failed',
  FAILED_FINAL: 'Failed',
  REJECTED: 'Rejected',
  NEEDS_RECONCILIATION: 'Under review',
};

// ─── Date helpers ───────────────────────────────────────────────────────────────

// A complete, real YYYY-MM-DD. Partial input (e.g. "2026-06-1") is INVALID so it never
// triggers a refetch or a client-side filter mid-typing.
function isValidYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Client-side date filter for campaigns/payouts (those endpoints take NO date param — only
// the donations endpoint does, server-side). ISO createdAt → YYYY-MM-DD lexical compare,
// which is chronological. `to` is date-INCLUSIVE (d <= to), matching the donations backend.
function inDateRange(createdAt: string, from: string, to: string): boolean {
  const d = createdAt.slice(0, 10);
  if (from && isValidYmd(from) && d < from) return false;
  if (to && isValidYmd(to) && d > to) return false;
  return true;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ label }: { label: string }) {
  return <Text style={styles.sectionLabel}>{label}</Text>;
}

// ─── Reports screen ───────────────────────────────────────────────────────────

export default function ReportsScreen() {
  const [reportType, setReportType] = useState<ReportType>('campaign_summary');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string>(ALL_GROUPS);
  const [format, setFormat] = useState<ReportFormat>('CSV');
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);

  const fromValid = dateFrom === '' || isValidYmd(dateFrom);
  const toValid = dateTo === '' || isValidYmd(dateTo);
  const datesOk = fromValid && toValid;

  // ── One combined fetch. The donations call carries from/to to the backend (date-INCLUSIVE,
  //    server-side); campaigns + payouts have no backend date param so they are filtered
  //    client-side (inDateRange) at render. Only VALID dates are sent to the server. ──
  const fetcher = useCallback(async (): Promise<ReportData> => {
    const donationParams: { from?: string; to?: string } = {};
    if (dateFrom && isValidYmd(dateFrom)) donationParams.from = dateFrom;
    if (dateTo && isValidYmd(dateTo)) donationParams.to = dateTo;
    const [campaigns, donationsPage, payouts] = await Promise.all([
      campaignsService.listMine(),
      churchesService.getMyDonations(donationParams),
      withdrawalsService.list(),
    ]);
    return {
      campaigns,
      donations: donationsPage.rows,
      donationsTotal: donationsPage.total,
      payouts,
    };
  }, [dateFrom, dateTo]);

  const { data, status, refetchError, retry } = useFocusRefetch<ReportData>(fetcher);

  // Refetch when the (valid) date range changes — donations are date-filtered server-side.
  // Mount-skip so the focus fetch isn't doubled; invalid/partial dates never refetch.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    if (datesOk) retry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo]);

  const selectedReport = REPORT_OPTIONS.find(r => r.id === reportType)!;

  // ── CSV download ──
  // WEB only for now (native share-sheet is a later slice). Enabled ONLY for Donation
  // History — the only report with a server-side export endpoint
  // (GET /churches/me/donations/export/). The other report types have no exporter yet,
  // so their button stays disabled rather than shipping one that 404s. The export is
  // full history (server streams the whole scoped set, un-paginated) — it does NOT honour
  // the on-screen date range.
  const isWeb = Platform.OS === 'web';
  const canDownloadDonations = reportType === 'donation_history' && isWeb;

  // Clear any stale download error when the report type changes.
  useEffect(() => { setDownloadError(false); }, [reportType]);

  const handleDownload = useCallback(async () => {
    if (downloading) return;
    setDownloadError(false);
    setDownloading(true);
    try {
      await churchesService.downloadMyDonationsCsv();
    } catch {
      setDownloadError(true);
    } finally {
      setDownloading(false);
    }
  }, [downloading]);

  const exportHint = canDownloadDonations
    ? 'Download the full donation history (NET amounts) as CSV.'
    : reportType === 'donation_history'
      ? 'CSV download is available on the web app.'
      : 'Downloadable exports for this report are coming soon.';
  const disabledDownloadLabel =
    reportType === 'donation_history' && !isWeb ? 'Download on web' : 'Download — coming soon';

  // Group options derived from the campaigns actually present — no mock, no extra fetch.
  // Group filtering applies to Campaign Summary only (donations/payouts carry no group).
  const groupOptions = useMemo<string[]>(() => {
    const names = Array.from(
      new Set((data?.campaigns ?? []).map(c => c.groupLabelName).filter(Boolean) as string[]),
    ).sort();
    return [ALL_GROUPS, ...names];
  }, [data]);

  // ── Derive the rows for the active report type (client-side date + group filtering). ──
  const campaignRows = useMemo(() => {
    let rows = (data?.campaigns ?? []).filter(c => inDateRange(c.createdAt, dateFrom, dateTo));
    if (selectedGroup !== ALL_GROUPS) rows = rows.filter(c => c.groupLabelName === selectedGroup);
    return rows;
  }, [data, dateFrom, dateTo, selectedGroup]);

  const donationRows = data?.donations ?? [];   // already date-filtered server-side (max 20)
  // True total of matching donations across all pages (server-side count). Because the
  // donations query is filtered ENTIRELY server-side, this is exact — unlike campaigns/
  // payouts, which are client-filtered over page 1 and so have no trustworthy total.
  const donationsTotal = data?.donationsTotal ?? 0;
  const donationsTruncated = donationsTotal > donationRows.length;

  const payoutRows = useMemo(
    () => (data?.payouts ?? []).filter(w => inDateRange(w.createdAt, dateFrom, dateTo)),
    [data, dateFrom, dateTo],
  );

  const rowCount =
    reportType === 'campaign_summary' ? campaignRows.length
      : reportType === 'donation_history' ? donationRows.length
        : payoutRows.length;

  // ── Results body (loading / error / empty / table) ──
  function renderResults() {
    if (status === 'loading') {
      return (
        <View style={styles.stateBox}>
          <ActivityIndicator color={Colors.primary} />
          <Text style={styles.stateText}>Loading…</Text>
        </View>
      );
    }
    if (status === 'error') {
      return (
        <View style={styles.stateBox}>
          <Ionicons name="cloud-offline-outline" size={28} color={Colors.textMuted} />
          <Text style={styles.stateText}>Couldn’t load report data.</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={retry} activeOpacity={0.85}>
            <Text style={styles.retryBtnText}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (rowCount === 0) {
      return (
        <View style={styles.stateBox}>
          <Ionicons name="document-text-outline" size={28} color={Colors.textMuted} />
          <Text style={styles.stateText}>No records for this report.</Text>
        </View>
      );
    }
    if (reportType === 'campaign_summary') return <CampaignTable rows={campaignRows} />;
    if (reportType === 'donation_history') {
      return (
        <>
          {donationsTruncated && (
            <View style={styles.truncationBanner}>
              <Ionicons name="information-circle-outline" size={16} color={Colors.primary} />
              <Text style={styles.truncationBannerText}>
                Showing {donationRows.length} of {donationsTotal}. Download CSV for the full list.
              </Text>
            </View>
          )}
          <DonationTable rows={donationRows} />
        </>
      );
    }
    return <PayoutTable rows={payoutRows} />;
  }

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Report type ── */}
        <View style={styles.card}>
          <SectionLabel label="Report Type" />
          {REPORT_OPTIONS.map((option, index) => {
            const isSelected = reportType === option.id;
            return (
              <TouchableOpacity
                key={option.id}
                style={[
                  styles.reportOption,
                  index < REPORT_OPTIONS.length - 1 && styles.reportOptionBorder,
                ]}
                onPress={() => setReportType(option.id)}
                activeOpacity={0.7}
                accessibilityRole="radio"
                accessibilityLabel={option.label}
                accessibilityState={{ selected: isSelected }}
              >
                <View style={[styles.reportIconCircle, isSelected && styles.reportIconCircleSelected]}>
                  <Ionicons
                    name={option.icon}
                    size={20}
                    color={isSelected ? Colors.white : Colors.textMuted}
                  />
                </View>
                <View style={styles.reportOptionBody}>
                  <Text style={[styles.reportOptionLabel, isSelected && styles.reportOptionLabelSelected]}>
                    {option.label}
                  </Text>
                  <Text style={styles.reportOptionDesc} numberOfLines={2}>
                    {option.description}
                  </Text>
                </View>
                {isSelected ? (
                  <Ionicons name="checkmark-circle" size={22} color={Colors.primary} />
                ) : (
                  <View style={styles.radioCircle} />
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Filters ── */}
        <View style={styles.card}>
          <SectionLabel label="Filters" />

          {/* Date range */}
          <View style={styles.dateRow}>
            <View style={styles.dateField}>
              <Text style={styles.dateLabel}>From</Text>
              <TextInput
                style={[styles.dateInput, !fromValid && styles.dateInputError]}
                value={dateFrom}
                onChangeText={setDateFrom}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={Colors.textMuted}
                keyboardType="numbers-and-punctuation"
                maxLength={10}
                accessibilityLabel="Date from"
              />
            </View>
            <View style={styles.dateSep}>
              <Text style={styles.dateSepText}>→</Text>
            </View>
            <View style={styles.dateField}>
              <Text style={styles.dateLabel}>To</Text>
              <TextInput
                style={[styles.dateInput, !toValid && styles.dateInputError]}
                value={dateTo}
                onChangeText={setDateTo}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={Colors.textMuted}
                keyboardType="numbers-and-punctuation"
                maxLength={10}
                accessibilityLabel="Date to"
              />
            </View>
          </View>
          {!datesOk && (
            <Text style={styles.fieldError}>Enter dates as YYYY-MM-DD.</Text>
          )}

          {/* Group label filter — Campaign Summary only (donations/payouts carry no group). */}
          {reportType === 'campaign_summary' && (
            <View style={styles.filterRow}>
              <Text style={styles.filterLabel}>Group Label</Text>
              <TouchableOpacity
                style={styles.pickerField}
                onPress={() => setShowGroupPicker(true)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Filter by group label"
              >
                <Text style={styles.pickerFieldText}>{selectedGroup}</Text>
                <Ionicons name="chevron-down" size={16} color={Colors.textMuted} />
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* ── Export ── */}
        <View style={styles.card}>
          <SectionLabel label="Export" />
          <View style={styles.formatRow}>
            <View style={styles.formatInfo}>
              <Text style={styles.formatInfoTitle}>CSV / PDF export</Text>
              <Text style={styles.formatInfoDesc}>{exportHint}</Text>
            </View>
            {/* CSV/PDF toggle stays disabled — PDF is a separate slice. */}
            <View style={styles.toggleGroup}>
              {(['CSV', 'PDF'] as ReportFormat[]).map(f => (
                <View key={f} style={[styles.toggleBtn, styles.toggleBtnDisabled]}>
                  <Text style={styles.toggleBtnTextDisabled}>{f}</Text>
                </View>
              ))}
            </View>
          </View>

          {canDownloadDonations ? (
            <TouchableOpacity
              style={[styles.downloadBtn, styles.downloadBtnActive, downloading && styles.downloadBtnBusy]}
              onPress={handleDownload}
              disabled={downloading}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Download donation history CSV"
              accessibilityState={{ disabled: downloading, busy: downloading }}
            >
              {downloading ? (
                <>
                  <ActivityIndicator color={Colors.white} size="small" />
                  <Text style={styles.downloadBtnTextActive}>Preparing…</Text>
                </>
              ) : (
                <>
                  <Ionicons name="download-outline" size={20} color={Colors.white} />
                  <Text style={styles.downloadBtnTextActive}>Download CSV</Text>
                </>
              )}
            </TouchableOpacity>
          ) : (
            <View
              style={[styles.downloadBtn, styles.downloadBtnDisabled]}
              accessibilityRole="button"
              accessibilityState={{ disabled: true }}
              accessibilityLabel={disabledDownloadLabel}
            >
              <Ionicons name="download-outline" size={20} color={Colors.textMuted} />
              <Text style={styles.downloadBtnTextDisabled}>{disabledDownloadLabel}</Text>
            </View>
          )}

          {downloadError && (
            <Text style={styles.downloadError}>Couldn’t download. Please try again.</Text>
          )}
        </View>

        {/* ── Results ── */}
        <View style={styles.card}>
          <View style={styles.summaryRow}>
            <Ionicons name={selectedReport.icon} size={20} color={Colors.primary} />
            <View style={styles.summaryText}>
              <Text style={styles.summaryTitle}>{selectedReport.label}</Text>
              <Text style={styles.summaryMeta}>
                {dateFrom || dateTo ? `${dateFrom || '…'} → ${dateTo || '…'}` : 'All dates'}
                {status === 'ok' ? ` · ${rowCount} ${rowCount === 1 ? 'row' : 'rows'}` : ''}
              </Text>
            </View>
          </View>

          {refetchError && (
            <Text style={styles.refetchNote}>Showing last loaded data — refresh failed.</Text>
          )}

          {renderResults()}
        </View>
      </ScrollView>

      {/* ── Group picker modal ── */}
      <RNModal
        visible={showGroupPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowGroupPicker(false)}
      >
        <TouchableOpacity
          style={styles.pickerOverlay}
          onPress={() => setShowGroupPicker(false)}
          activeOpacity={1}
        />
        <View style={styles.pickerSheet}>
          <View style={styles.pickerHandle} />
          <Text style={styles.pickerTitle}>Filter by Group</Text>
          <FlatList
            data={groupOptions}
            keyExtractor={item => item}
            renderItem={({ item }) => {
              const isSelected = item === selectedGroup;
              return (
                <TouchableOpacity
                  style={styles.pickerItem}
                  onPress={() => { setSelectedGroup(item); setShowGroupPicker(false); }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.pickerItemText, isSelected && styles.pickerItemTextSelected]}>
                    {item}
                  </Text>
                  {isSelected ? (
                    <Ionicons name="checkmark" size={20} color={Colors.primary} />
                  ) : null}
                </TouchableOpacity>
              );
            }}
            ItemSeparatorComponent={() => <View style={styles.pickerSep} />}
          />
        </View>
      </RNModal>
    </View>
  );
}

// ─── Tables ─────────────────────────────────────────────────────────────────────

function CampaignTable({ rows }: { rows: TreasurerCampaign[] }) {
  return (
    <View style={styles.table}>
      <View style={styles.tableHeadRow}>
        <Text style={[styles.th, styles.colWide]}>Campaign</Text>
        <Text style={[styles.th, styles.colNum]}>Goal</Text>
        <Text style={[styles.th, styles.colNum]}>Raised</Text>
        <Text style={[styles.th, styles.colNum]}>Wallet</Text>
      </View>
      {rows.map(c => (
        <View key={c.id} style={styles.tableRow}>
          <Text style={[styles.td, styles.colWide]} numberOfLines={2}>{c.title}</Text>
          <Text style={[styles.tdNum, styles.colNum]}>{fmtKes(c.goalAmount)}</Text>
          <Text style={[styles.tdNum, styles.colNum]}>{fmtKes(c.raisedAmount)}</Text>
          <Text style={[styles.tdNum, styles.colNum, styles.tdStrong]}>{fmtKes(c.walletBalance)}</Text>
        </View>
      ))}
    </View>
  );
}

function DonationTable({ rows }: { rows: MyDonationRow[] }) {
  return (
    <View style={styles.table}>
      <View style={styles.tableHeadRow}>
        <Text style={[styles.th, styles.colDate]}>Date</Text>
        <Text style={[styles.th, styles.colRcpt]}>Receipt</Text>
        <Text style={[styles.th, styles.colWide]}>Donor</Text>
        <Text style={[styles.th, styles.colNum]}>Amount</Text>
      </View>
      {rows.map((d, i) => (
        // Receipt is NOT guaranteed unique (the serializer exposes no row id, and a
        // sandbox can repeat a receipt across rows), so the key is receipt + index.
        <View key={`${d.receipt}-${i}`} style={styles.tableRow}>
          <Text style={[styles.td, styles.colDate]}>{formatDate(d.createdAt)}</Text>
          <Text style={[styles.td, styles.colRcpt]} numberOfLines={1}>{d.receipt}</Text>
          <Text style={[styles.td, styles.colWide]} numberOfLines={1}>{d.donorName ?? 'Anonymous'}</Text>
          <Text style={[styles.tdNum, styles.colNum, styles.tdStrong]}>{fmtKes(d.netAmount)}</Text>
        </View>
      ))}
    </View>
  );
}

function PayoutTable({ rows }: { rows: Withdrawal[] }) {
  return (
    <View style={styles.table}>
      <View style={styles.tableHeadRow}>
        <Text style={[styles.th, styles.colDate]}>Date</Text>
        <Text style={[styles.th, styles.colNum]}>Amount</Text>
        <Text style={[styles.th, styles.colStat]}>Status</Text>
        <Text style={[styles.th, styles.colRcpt]}>Receipt</Text>
      </View>
      {rows.map(w => (
        <View key={w.id} style={styles.tableRow}>
          <Text style={[styles.td, styles.colDate]}>{formatDate(w.createdAt)}</Text>
          <Text style={[styles.tdNum, styles.colNum, styles.tdStrong]}>{fmtKes(w.amount)}</Text>
          <Text style={[styles.td, styles.colStat]}>{WITHDRAWAL_STATUS_LABEL[w.status]}</Text>
          <Text style={[styles.td, styles.colRcpt]} numberOfLines={1}>
            {w.status === 'PAID' && w.payoutReference ? w.payoutReference : '—'}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.grey,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: Spacing.md,
    gap: Spacing.md,
    paddingBottom: Spacing.xl,
  },

  // Card
  card: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
    gap: Spacing.sm,
  },
  sectionLabel: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.text,
    marginBottom: 2,
  },

  // Report type options
  reportOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
  },
  reportOptionBorder: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.grey,
  },
  reportIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.grey,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  reportIconCircleSelected: {
    backgroundColor: Colors.primary,
  },
  reportOptionBody: {
    flex: 1,
    gap: 2,
  },
  reportOptionLabel: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.text,
  },
  reportOptionLabelSelected: {
    color: Colors.primary,
  },
  reportOptionDesc: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    lineHeight: 16,
  },
  radioCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: Colors.border,
    flexShrink: 0,
  },

  // Date range
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dateField: {
    flex: 1,
    gap: 4,
  },
  dateLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  dateInput: {
    height: 44,
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.text,
    backgroundColor: Colors.white,
  },
  dateInputError: {
    borderColor: Colors.danger,
  },
  dateSep: {
    paddingTop: 20,
  },
  dateSepText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
  },
  fieldError: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.danger,
  },

  // Group filter
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
  },
  filterLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    flexShrink: 0,
  },
  pickerField: {
    flex: 1,
    height: 44,
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.white,
  },
  pickerFieldText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.text,
    flex: 1,
  },

  // Format toggle (disabled)
  formatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  formatInfo: {
    flex: 1,
    gap: 2,
  },
  formatInfoTitle: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  formatInfoDesc: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  toggleGroup: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
  },
  toggleBtn: {
    paddingHorizontal: 20,
    paddingVertical: 9,
    backgroundColor: Colors.white,
  },
  toggleBtnDisabled: {
    backgroundColor: Colors.grey,
  },
  toggleBtnTextDisabled: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  downloadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: Spacing.touch,
    borderRadius: BorderRadius.md,
    gap: 8,
  },
  downloadBtnDisabled: {
    backgroundColor: Colors.grey,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  downloadBtnTextDisabled: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.textMuted,
  },
  downloadBtnActive: {
    backgroundColor: Colors.primary,
  },
  downloadBtnBusy: {
    opacity: 0.7,
  },
  downloadBtnTextActive: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.white,
  },
  downloadError: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.danger,
    textAlign: 'center',
    marginTop: 4,
  },

  // Summary
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.md,
    padding: Spacing.sm,
  },
  summaryText: {
    flex: 1,
    gap: 2,
  },
  summaryTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.primary,
  },
  summaryMeta: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.primary,
    opacity: 0.8,
  },
  refetchNote: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.warning,
  },
  truncationBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.md,
    paddingVertical: 8,
    paddingHorizontal: Spacing.sm,
    marginTop: 4,
  },
  truncationBannerText: {
    flex: 1,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.primary,
  },

  // State boxes (loading / error / empty)
  stateBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.xl,
    gap: Spacing.sm,
  },
  stateText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 4,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: BorderRadius.md,
    borderWidth: 1.5,
    borderColor: Colors.primary,
  },
  retryBtnText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },

  // Table
  table: {
    marginTop: 4,
  },
  tableHeadRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    borderBottomWidth: 1.5,
    borderBottomColor: Colors.border,
    gap: 6,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.grey,
    gap: 6,
    alignItems: 'center',
  },
  th: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
  },
  td: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.text,
  },
  tdNum: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.text,
    textAlign: 'right',
  },
  tdStrong: {
    fontFamily: 'Poppins-SemiBold',
    color: Colors.text,
  },
  colWide: { flex: 2.2 },
  colNum: { flex: 1.6, textAlign: 'right' },
  colDate: { flex: 1.5 },
  colRcpt: { flex: 1.7 },
  colStat: { flex: 1.3 },

  // Picker modal
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  pickerSheet: {
    backgroundColor: Colors.white,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xxl,
    maxHeight: '50%',
  },
  pickerHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: 'center',
    marginBottom: Spacing.md,
  },
  pickerTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.sm,
  },
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    height: Spacing.touch,
  },
  pickerItemText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.text,
    flex: 1,
  },
  pickerItemTextSelected: {
    fontFamily: 'Poppins-SemiBold',
    color: Colors.primary,
  },
  pickerSep: {
    height: 1,
    backgroundColor: Colors.grey,
    marginHorizontal: Spacing.md,
  },
});
