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
import { groupsService } from '../../services/groups.service';
import { MyDonationRow } from '../../services/mappers';
import { withdrawalsService } from '../../services/withdrawals.service';
import { GroupLabel, TreasurerCampaign, Withdrawal, WithdrawalStatus } from '../../types';
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
  campaigns: TreasurerCampaign[];   // date + group filtered SERVER-SIDE (from/to/group_label); max 20 (page 1)
  campaignsTotal: number;       // true total of matching campaigns across ALL pages
  donations: MyDonationRow[];   // server-side date-filtered (from/to); max 20 (page 1)
  donationsTotal: number;       // true total of matching donations across ALL pages
  payouts: Withdrawal[];        // server-side date-filtered (from/to); max 20 (page 1)
  payoutsTotal: number;         // true total of matching payouts across ALL pages
  groups: GroupLabel[];         // active group labels — the id+name source for the picker
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

// selectedGroup holds a GroupLabel FK id; this empty-string sentinel means "no group
// filter" (never sent to the server). ALL_GROUPS_LABEL is only for display.
const ALL_GROUPS = '';
const ALL_GROUPS_LABEL = 'All Groups';

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

  // ── One combined fetch. Campaigns, donations AND payouts all carry from/to to the
  //    backend (date-INCLUSIVE, server-side), so the date filter stays correct past
  //    page 1. Campaign GROUP filtering is now ALSO server-side: the selected group's
  //    FK id goes to /campaigns/mine/ as ?group_label, so it too stays correct past
  //    page 1. Only VALID dates are sent. The groups list (active labels, id+name) is
  //    fetched here as the picker's source — independent of dates/group but folded into
  //    the one loading path (idempotent GET). ──
  const fetcher = useCallback(async (): Promise<ReportData> => {
    const dateParams: { from?: string; to?: string } = {};
    if (dateFrom && isValidYmd(dateFrom)) dateParams.from = dateFrom;
    if (dateTo && isValidYmd(dateTo)) dateParams.to = dateTo;
    const campaignParams: { from?: string; to?: string; group_label?: string } = { ...dateParams };
    if (selectedGroup !== ALL_GROUPS) campaignParams.group_label = selectedGroup;
    const [campaignsPage, donationsPage, payoutsPage, groups] = await Promise.all([
      campaignsService.listMineWithTotal(campaignParams),
      churchesService.getMyDonations(dateParams),
      withdrawalsService.listWithTotal(dateParams),
      groupsService.list(),
    ]);
    return {
      campaigns: campaignsPage.rows,
      campaignsTotal: campaignsPage.total,
      donations: donationsPage.rows,
      donationsTotal: donationsPage.total,
      payouts: payoutsPage.rows,
      payoutsTotal: payoutsPage.total,
      groups,
    };
  }, [dateFrom, dateTo, selectedGroup]);

  const { data, status, refetchError, retry } = useFocusRefetch<ReportData>(fetcher);

  // Refetch when the (valid) date range OR the selected group changes — both are now
  // filtered server-side. Mount-skip so the focus fetch isn't doubled; invalid/partial
  // dates never refetch (a group change still respects the datesOk guard).
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    if (datesOk) retry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, selectedGroup]);

  const selectedReport = REPORT_OPTIONS.find(r => r.id === reportType)!;

  // ── CSV download ──
  // WEB only for now (native share-sheet is a later slice). All three report types now
  // have a server-side export endpoint: Campaign Summary (GET /campaigns/mine/export/),
  // Donation History (GET /churches/me/donations/export/) and Payout History
  // (GET /withdrawals/export/). Each streams the whole scoped set un-paginated, so the
  // exports are FULL history — they do NOT honour the on-screen date/group range.
  const isWeb = Platform.OS === 'web';
  const isExportable =
    reportType === 'donation_history' ||
    reportType === 'payout_history' ||
    reportType === 'campaign_summary';
  const canDownload = isExportable && isWeb;

  // PDF export now exists for ALL three report types (each has a backend ?format=pdf
  // endpoint: donations, payouts, campaigns), so the CSV/PDF toggle is enabled everywhere.
  const pdfAvailable = true;
  // The format actually used for the download + all labels: force CSV for any type
  // without a PDF endpoint, so a stale 'PDF' can never route a CSV-only report to a 404.
  // (Now that every type has a PDF endpoint this collapses to `format`, but the guard
  // is kept as a defensive no-op in case a future CSV-only report type is added.)
  const effectiveFormat: ReportFormat = pdfAvailable ? format : 'CSV';

  // Clear the stale download error AND reset the format toggle when the report type
  // changes — a leftover 'PDF' must not carry into payouts/campaigns (CSV-only).
  useEffect(() => { setDownloadError(false); setFormat('CSV'); }, [reportType]);

  const handleDownload = useCallback(async () => {
    if (downloading) return;
    setDownloadError(false);
    setDownloading(true);
    try {
      // Every report type now has both a CSV and a PDF endpoint; route on the toggle.
      // PDF only when the toggle is on PDF; every other case (incl. a stale format)
      // falls to CSV.
      if (reportType === 'payout_history') {
        if (format === 'PDF') {
          await withdrawalsService.downloadPayoutsPdf();
        } else {
          await withdrawalsService.downloadPayoutsCsv();
        }
      } else if (reportType === 'campaign_summary') {
        if (format === 'PDF') {
          await campaignsService.downloadCampaignsPdf();
        } else {
          await campaignsService.downloadCampaignsCsv();
        }
      } else {
        // donation_history
        if (format === 'PDF') {
          await churchesService.downloadMyDonationsPdf();
        } else {
          await churchesService.downloadMyDonationsCsv();
        }
      }
    } catch {
      setDownloadError(true);
    } finally {
      setDownloading(false);
    }
  }, [downloading, reportType, format]);

  const exportHint = canDownload
    ? reportType === 'payout_history'
      ? `Download the full payout history (NET amounts) as ${effectiveFormat}.`
      : reportType === 'campaign_summary'
        ? `Download the full campaign list (NET amounts) as ${effectiveFormat}.`
        : `Download the full donation history (NET amounts) as ${effectiveFormat}.`
    : isExportable
      ? 'CSV download is available on the web app.'
      : 'Downloadable exports for this report are coming soon.';
  const disabledDownloadLabel =
    isExportable && !isWeb ? 'Download on web' : 'Download — coming soon';

  // Group options come from the groups list ({id,name}) — NOT the campaign rows — so the
  // picker lists every active label (including ones with no campaign on page 1) and each
  // option carries the FK id the server filter needs. Group filtering applies to Campaign
  // Summary only (donations/payouts carry no group). The ALL sentinel comes first.
  const groupOptions = useMemo<{ id: string; name: string }[]>(() => {
    const groups = (data?.groups ?? [])
      .map(g => ({ id: g.id, name: g.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [{ id: ALL_GROUPS, name: ALL_GROUPS_LABEL }, ...groups];
  }, [data]);

  // The current group's display name (the picker stores the id, the field shows the name).
  const selectedGroupName = useMemo(
    () => groupOptions.find(o => o.id === selectedGroup)?.name ?? ALL_GROUPS_LABEL,
    [groupOptions, selectedGroup],
  );

  // ── Rows for the active report type. Campaigns are now fully server-filtered (date via
  //    from/to AND group via group_label), so there is NO client-side filtering left —
  //    the returned page is correct past row 20 for both filters. ──
  const campaignRows = data?.campaigns ?? [];
  // True total of matching campaigns across all pages (server-side count). Because the
  // campaigns query is filtered ENTIRELY server-side (from/to AND group_label applied
  // before pagination), this count is exact — so the banner honours BOTH filters.
  const campaignsTotal = data?.campaignsTotal ?? 0;
  const campaignsTruncated = campaignsTotal > campaignRows.length;

  const donationRows = data?.donations ?? [];   // already date-filtered server-side (max 20)
  // True total of matching donations across all pages (server-side count). Because the
  // donations query is filtered ENTIRELY server-side, this is exact — unlike campaigns/
  // payouts, which are client-filtered over page 1 and so have no trustworthy total.
  const donationsTotal = data?.donationsTotal ?? 0;
  const donationsTruncated = donationsTotal > donationRows.length;

  const payoutRows = data?.payouts ?? [];   // already date-filtered server-side (from/to)
  // True total of matching payouts across all pages (server-side count). Because the
  // payouts query is filtered ENTIRELY server-side (from/to/status/campaign all applied
  // before pagination), this count is exact — unlike campaigns, which is client-filtered
  // over page 1 and so has no trustworthy total.
  const payoutsTotal = data?.payoutsTotal ?? 0;
  const payoutsTruncated = payoutsTotal > payoutRows.length;

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
    if (reportType === 'campaign_summary') {
      return (
        <>
          {campaignsTruncated && (
            <View style={styles.truncationBanner}>
              <Ionicons name="information-circle-outline" size={16} color={Colors.primary} />
              <Text style={styles.truncationBannerText}>
                Showing {campaignRows.length} of {campaignsTotal}. Download CSV for the full list.
              </Text>
            </View>
          )}
          <CampaignTable rows={campaignRows} />
        </>
      );
    }
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
    return (
      <>
        {payoutsTruncated && (
          <View style={styles.truncationBanner}>
            <Ionicons name="information-circle-outline" size={16} color={Colors.primary} />
            <Text style={styles.truncationBannerText}>
              Showing {payoutRows.length} of {payoutsTotal}. Download CSV for the full list.
            </Text>
          </View>
        )}
        <PayoutTable rows={payoutRows} />
      </>
    );
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
                <Text style={styles.pickerFieldText}>{selectedGroupName}</Text>
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
            {/* CSV/PDF toggle — enabled ONLY for donation_history (the sole type with a
                PDF endpoint). For payouts/campaigns the PDF option is locked (disabled)
                and CSV stays selected, so no button ever targets a non-existent PDF. */}
            <View style={styles.toggleGroup}>
              {(['CSV', 'PDF'] as ReportFormat[]).map(f => {
                const optionEnabled = f === 'CSV' || pdfAvailable;
                const isActive = effectiveFormat === f;
                return (
                  <TouchableOpacity
                    key={f}
                    style={[
                      styles.toggleBtn,
                      isActive && styles.toggleBtnActive,
                      !optionEnabled && styles.toggleBtnDisabled,
                    ]}
                    onPress={() => { if (optionEnabled) setFormat(f); }}
                    disabled={!optionEnabled}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isActive, disabled: !optionEnabled }}
                    accessibilityLabel={`${f} format`}
                  >
                    <Text
                      style={
                        isActive
                          ? styles.toggleBtnTextActive
                          : optionEnabled
                            ? styles.toggleBtnText
                            : styles.toggleBtnTextDisabled
                      }
                    >
                      {f}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {canDownload ? (
            <TouchableOpacity
              style={[styles.downloadBtn, styles.downloadBtnActive, downloading && styles.downloadBtnBusy]}
              onPress={handleDownload}
              disabled={downloading}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={
                reportType === 'payout_history'
                  ? `Download payout history ${effectiveFormat}`
                  : reportType === 'campaign_summary'
                    ? `Download campaign summary ${effectiveFormat}`
                    : `Download donation history ${effectiveFormat}`
              }
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
                  <Text style={styles.downloadBtnTextActive}>Download {effectiveFormat}</Text>
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
            keyExtractor={item => item.id || ALL_GROUPS_LABEL}
            renderItem={({ item }) => {
              const isSelected = item.id === selectedGroup;
              return (
                <TouchableOpacity
                  style={styles.pickerItem}
                  onPress={() => { setSelectedGroup(item.id); setShowGroupPicker(false); }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.pickerItemText, isSelected && styles.pickerItemTextSelected]}>
                    {item.name}
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
  toggleBtnActive: {
    backgroundColor: Colors.primary,
  },
  toggleBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  toggleBtnTextActive: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.sm,
    color: Colors.white,
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
