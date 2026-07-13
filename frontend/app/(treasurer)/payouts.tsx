import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useIsWideWeb } from '../../components/layout/Screen';
import DisbursementApprovalDialog from '../../components/disbursement/DisbursementApprovalDialog';
import Modal from '../../components/ui/Modal';
import ResponsiveSheet from '../../components/ui/ResponsiveSheet';
import { BorderRadius, Colors, FontSize, Shadows, Spacing } from '../../constants/theme';
import { withdrawalsService } from '../../services/withdrawals.service';
import { Withdrawal, WithdrawalStatus } from '../../types';
import { fmtKes, timeAgo } from '../../utils/formatters';

// Verdict-poll bound for an approved (PROCESSING) payout — mirrors the donation
// slice's discipline. ~30s ceiling before falling back to the honest "still
// confirming" PROCESSING terminal rather than spinning forever.
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 10;

// Mirrors the backend's MAX_RETRIES (withdrawals/models.py) — gates the Retry button
// client-side; the backend re-checks under lock regardless.
const MAX_RETRIES = 5;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function maskPhone(phone: string): string {
  if (phone.length < 4) return '****';
  return `0*** ***${phone.slice(-4)}`;
}

// ─── Status config ────────────────────────────────────────────────────────────

type FilterStatus = WithdrawalStatus | 'ALL';

const STATUS_LABELS: Record<FilterStatus, string> = {
  ALL:                  'All',
  PENDING_APPROVAL:     'Pending',
  PROCESSING:           'Processing',
  PAID:                 'Paid',
  FAILED:               'Failed',
  FAILED_FINAL:         'Failed Final',
  REJECTED:             'Rejected',
  NEEDS_RECONCILIATION: 'Under Review',
};

const STATUS_BADGE: Record<WithdrawalStatus, { bg: string; text: string }> = {
  PENDING_APPROVAL:     { bg: Colors.warningLight, text: Colors.warning },
  PROCESSING:           { bg: Colors.primaryLight, text: Colors.primary },
  PAID:                 { bg: Colors.successLight, text: Colors.success },
  FAILED:               { bg: Colors.dangerLight,  text: Colors.danger },
  FAILED_FINAL:         { bg: Colors.danger,        text: Colors.white },
  REJECTED:             { bg: Colors.grey,          text: Colors.textMuted },
  // Neutral "under review" — money in limbo, being checked; NOT success/error.
  NEEDS_RECONCILIATION: { bg: Colors.accentLight,   text: Colors.accentDark },
};

function StatusBadge({ status }: { status: WithdrawalStatus }) {
  const c = STATUS_BADGE[status];
  return (
    <View style={[styles.statusBadge, { backgroundColor: c.bg }]}>
      <Text style={[styles.statusBadgeText, { color: c.text }]}>
        {STATUS_LABELS[status]}
      </Text>
    </View>
  );
}

// ─── Filter chip ──────────────────────────────────────────────────────────────

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.filterChip, active && styles.filterChipActive]}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Filter by ${label}`}
    >
      <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ─── Withdrawal row ───────────────────────────────────────────────────────────

interface WithdrawalRowProps {
  item: Withdrawal;
  onApprove: (item: Withdrawal) => void;
  onReject: (item: Withdrawal) => void;
  onRetry: (id: string) => void;
  stillConfirming: boolean;
}

function WithdrawalRow({ item, onApprove, onReject, onRetry, stillConfirming }: WithdrawalRowProps) {
  const isFinalFail = item.status === 'FAILED_FINAL';

  return (
    <View style={[styles.row, isFinalFail && styles.rowDanger]}>
      {isFinalFail ? (
        <View style={styles.investigationBanner}>
          <Ionicons name="alert-circle" size={14} color={Colors.danger} />
          <Text style={styles.investigationText}>Requires PamojaHub investigation</Text>
        </View>
      ) : null}

      <View style={styles.rowTop}>
        <View style={styles.rowLeft}>
          <Text style={styles.campaignTitle} numberOfLines={1}>
            {item.campaignTitle}
          </Text>
          <Text style={styles.rowReason} numberOfLines={2}>
            {item.reason}
          </Text>
          <View style={styles.rowMeta}>
            <Text style={styles.rowPhone}>{maskPhone(item.requestedByPhone)}</Text>
            <Text style={styles.rowDot}>·</Text>
            <Text style={styles.rowDate}>{timeAgo(item.createdAt)}</Text>
          </View>
        </View>
        <View style={styles.rowRight}>
          <Text style={styles.amount}>{fmtKes(item.amount)}</Text>
          <StatusBadge status={item.status} />
        </View>
      </View>

      {item.status === 'PROCESSING' && stillConfirming ? (
        <View style={styles.confirmingNote}>
          <Ionicons name="time-outline" size={14} color={Colors.primary} />
          <Text style={styles.confirmingNoteText}>Dispatched — still confirming, check back shortly</Text>
        </View>
      ) : null}

      {item.status === 'REJECTED' && item.rejectionReason ? (
        <View style={styles.rejectionNote}>
          <Text style={styles.rejectionLabel}>Rejection reason</Text>
          <Text style={styles.rejectionText}>{item.rejectionReason}</Text>
        </View>
      ) : null}

      {(item.status === 'FAILED' || item.status === 'FAILED_FINAL') && item.failureReason ? (
        <View style={styles.failureNote}>
          <Text style={styles.failureText}>{item.failureReason}</Text>
          {item.retryCount > 0 ? (
            <Text style={styles.retryCount}>Attempts: {item.retryCount}</Text>
          ) : null}
        </View>
      ) : null}

      {item.status === 'FAILED' && item.dispatchOutcome === 'AMBIGUOUS_FAILURE' ? (
        <View style={styles.confirmingNote}>
          <Ionicons name="shield-checkmark-outline" size={14} color={Colors.primary} />
          <Text style={styles.confirmingNoteText}>
            This payout couldn't be confirmed and is under review. An admin will resolve it — no action needed here.
          </Text>
        </View>
      ) : item.status === 'FAILED' && item.retryCount >= MAX_RETRIES ? (
        <View style={styles.confirmingNote}>
          <Ionicons name="alert-circle-outline" size={14} color={Colors.primary} />
          <Text style={styles.confirmingNoteText}>Maximum retries reached — contact support.</Text>
        </View>
      ) : null}

      {item.status === 'PENDING_APPROVAL' ? (
        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={styles.approveBtn}
            onPress={() => onApprove(item)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Approve payout"
          >
            <Ionicons name="checkmark-circle-outline" size={16} color={Colors.white} />
            <Text style={styles.approveBtnText}>Approve</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.rejectBtn}
            onPress={() => onReject(item)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Reject payout"
          >
            <Ionicons name="close-circle-outline" size={16} color={Colors.danger} />
            <Text style={styles.rejectBtnText}>Reject</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {item.status === 'FAILED' && item.retryCount < MAX_RETRIES && item.dispatchOutcome !== 'AMBIGUOUS_FAILURE' ? (
        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => onRetry(item.id)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Retry payout"
          >
            <Ionicons name="refresh-outline" size={16} color={Colors.warning} />
            <Text style={styles.retryBtnText}>Retry Payout</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

// ─── Payouts screen ────────────────────────────────────────────────────────────

const FILTER_ORDER: FilterStatus[] = [
  'ALL', 'PENDING_APPROVAL', 'PROCESSING', 'PAID', 'FAILED', 'FAILED_FINAL', 'REJECTED',
  'NEEDS_RECONCILIATION',
];

export default function PayoutsScreen() {
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('ALL');

  // Authed GET /withdrawals/ (church-scoped server-side). A hard 401 is handled by
  // the api interceptor (refresh → else logout). approve/reject are real writes;
  // retry remains a LOCAL-only stub (a later slice).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const data = await withdrawalsService.list();
        if (!cancelled) setWithdrawals(data);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  const [approvalTarget, setApprovalTarget] = useState<Withdrawal | null>(null);
  const [approveSubmitting, setApproveSubmitting] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  // Verdict-poll bookkeeping, one in-flight poll at a time (a single PENDING_APPROVAL
  // row is approved per dialog confirm). pollSettledRef stops a late tick from
  // overriding a row that already reached a terminal status by other means (e.g. a
  // manual refetch); mountedRef + clearPollTimer prevent setState-after-unmount.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAttemptsRef = useRef(0);
  const pollSettledRef = useRef(false);
  const mountedRef = useRef(true);
  // Ids currently showing the "still confirming" hint — added when a verdict poll
  // starts, removed ONLY when that row leaves PROCESSING (incl. via this poll OR a
  // later manual refetch). NOT removed on poll-attempts-exhausted: that's the honest
  // terminal where the hint is supposed to persist.
  const [confirmingIds, setConfirmingIds] = useState<Set<string>>(new Set());

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPollTimer();
    };
  }, [clearPollTimer]);

  // Silent verdict poll: calls list() directly (no setLoading/setReloadKey — must
  // never flash the global spinner). Stops on PAID / FAILED / FAILED_FINAL /
  // NEEDS_RECONCILIATION for the polled row; exhausting attempts while still
  // PROCESSING is an honest terminal too (leaves the row PROCESSING, never marks it
  // failed or paid).
  const startApprovalPoll = useCallback((id: string) => {
    pollAttemptsRef.current = 0;
    pollSettledRef.current = false;
    setConfirmingIds(prev => new Set(prev).add(id));
    const tick = async () => {
      pollAttemptsRef.current += 1;
      let rows: Withdrawal[] | null = null;
      try {
        rows = await withdrawalsService.list();
      } catch {
        rows = null; // transient blip — non-terminal attempt, keep polling
      }
      if (!mountedRef.current || pollSettledRef.current) return;

      if (rows) {
        const row = rows.find(w => w.id === id);
        setWithdrawals(rows);
        if (row && row.status !== 'PROCESSING') {
          pollSettledRef.current = true;
          clearPollTimer();
          setConfirmingIds(prev => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          return;
        }
      }

      if (pollAttemptsRef.current >= POLL_MAX_ATTEMPTS) {
        pollSettledRef.current = true;
        clearPollTimer();
        // Honest terminal: row stays PROCESSING, the "still confirming" hint persists
        // (id stays in confirmingIds), no retry control is offered on this status.
        return;
      }
      pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
  }, [clearPollTimer]);

  const [rejectTarget, setRejectTarget] = useState<Withdrawal | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectAttempted, setRejectAttempted] = useState(false);
  const [rejectSubmitting, setRejectSubmitting] = useState(false);
  const [rejectApiError, setRejectApiError] = useState<string | null>(null);
  const [kbOffset, setKbOffset] = useState(0);

  useEffect(() => {
    if (rejectTarget === null) { setKbOffset(0); return; }
    const show = Keyboard.addListener('keyboardDidShow', e => setKbOffset(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbOffset(0));
    return () => { show.remove(); hide.remove(); };
  }, [rejectTarget]);

  const filtered =
    statusFilter === 'ALL'
      ? withdrawals
      : withdrawals.filter(w => w.status === statusFilter);

  const pendingCount = withdrawals.filter(w => w.status === 'PENDING_APPROVAL').length;

  async function handleApproveConfirm() {
    if (!approvalTarget || approveSubmitting) return;
    setApproveError(null);
    setApproveSubmitting(true);
    try {
      const updated = await withdrawalsService.approve(approvalTarget.id);
      setWithdrawals(prev => prev.map(w => (w.id === updated.id ? updated : w)));
      setApprovalTarget(null);
      if (updated.status === 'PROCESSING' && updated.dispatchStatus !== 'failed_queued_for_retry') {
        // Happy path: Daraja accepted the dispatch — verdict comes async via callback.
        // NEVER show Paid here; start the silent verdict poll.
        startApprovalPoll(updated.id);
      }
      // status === 'FAILED' (dispatchStatus 'failed_queued_for_retry'): the row already
      // shows Failed from server-truth above — terminal, no poll needed.
    } catch (e: unknown) {
      const data = (e as { response?: { data?: Record<string, unknown> } })?.response?.data;
      const detail = typeof data?.['detail'] === 'string' ? (data['detail'] as string) : null;
      setApproveError(detail ?? "Couldn't approve. Try again.");
      if (detail === 'Only pending requests can be approved.') {
        // Double-approve / wrong-status race — close the dialog, refetch to correct the stale row.
        setApprovalTarget(null);
        setReloadKey(k => k + 1);
      }
    } finally {
      setApproveSubmitting(false);
    }
  }

  function handleRejectOpen(item: Withdrawal) {
    setRejectTarget(item);
    setRejectReason('');
    setRejectAttempted(false);
    setRejectApiError(null);
  }

  async function handleRejectSubmit() {
    setRejectApiError(null);
    if (rejectReason.trim().length < 5) {
      setRejectAttempted(true);
      return;
    }
    if (!rejectTarget) return;
    setRejectSubmitting(true);
    try {
      const updated = await withdrawalsService.reject(rejectTarget.id, rejectReason.trim());
      setWithdrawals(prev => prev.map(w => w.id === updated.id ? updated : w));
      setRejectTarget(null);
      setRejectReason('');
      setRejectAttempted(false);
    } catch (e: unknown) {
      const data = (e as { response?: { data?: Record<string, unknown> } })?.response?.data;
      if (Array.isArray(data?.['rejection_reason']) && typeof data?.['rejection_reason']?.[0] === 'string') {
        setRejectApiError(data['rejection_reason'][0] as string);
      } else if (typeof data?.['detail'] === 'string') {
        const detail = data['detail'] as string;
        setRejectApiError(detail);
        if (detail === 'Only pending requests can be rejected.') {
          // Wrong-status race: close the sheet, refetch so the stale row corrects.
          setRejectTarget(null);
          setRejectReason('');
          setRejectAttempted(false);
          setReloadKey(k => k + 1);
        }
      } else {
        setRejectApiError("Couldn't reject. Try again.");
      }
    } finally {
      setRejectSubmitting(false);
    }
  }

  const [retryTarget, setRetryTarget] = useState<Withdrawal | null>(null);
  const [retrySubmitting, setRetrySubmitting] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  function handleRetryOpen(id: string) {
    setRetryTarget(withdrawals.find(w => w.id === id) ?? null);
    setRetryError(null);
  }

  async function handleRetryConfirm() {
    if (!retryTarget || retrySubmitting) return;
    setRetryError(null);
    setRetrySubmitting(true);
    try {
      const updated = await withdrawalsService.retry(retryTarget.id);
      setWithdrawals(prev => prev.map(w => (w.id === updated.id ? updated : w)));
      setRetryTarget(null);
      if (updated.status === 'PROCESSING' && updated.dispatchStatus !== 'failed_queued_for_retry') {
        // Happy path: Daraja accepted the re-dispatch — verdict comes async via callback.
        // NEVER show Paid here; start the silent verdict poll (same harness as approve).
        startApprovalPoll(updated.id);
      }
      // status === 'FAILED' (dispatchStatus 'failed_queued_for_retry'): the row already
      // shows Failed from server-truth above — terminal, no poll needed.
    } catch (e: unknown) {
      const data = (e as { response?: { data?: Record<string, unknown> } })?.response?.data;
      const detail = typeof data?.['detail'] === 'string' ? (data['detail'] as string) : null;
      setRetryError(detail ?? "Couldn't retry. Try again.");
      if (
        detail === 'Only failed payouts can be retried.' ||
        detail === 'Maximum retries reached; contact support.' ||
        detail === 'This payout could not be confirmed as un-sent and must be reconciled before it can be retried.'
      ) {
        // Row changed under us (race) — close, refetch so the row re-renders correctly
        // (the Retry button may now correctly disappear).
        setRetryTarget(null);
        setReloadKey(k => k + 1);
      }
    } finally {
      setRetrySubmitting(false);
    }
  }

  const isWideWeb = useIsWideWeb();

  return (
    <View style={styles.root}>
      {/* ── Filter bar ── */}
      <View style={[styles.filterBar, isWideWeb && styles.wideColumn]}>
        {pendingCount > 0 ? (
          <View style={styles.pendingBanner}>
            <View style={styles.pendingIconCircle}>
              <Ionicons name="time-outline" size={15} color={Colors.white} />
            </View>
            <Text style={styles.pendingBannerText}>
              {pendingCount} payout{pendingCount !== 1 ? 's' : ''} awaiting your approval
            </Text>
          </View>
        ) : null}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsScroll}
        >
          {FILTER_ORDER.map(s => (
            <FilterChip
              key={s}
              label={STATUS_LABELS[s]}
              active={statusFilter === s}
              onPress={() => setStatusFilter(s)}
            />
          ))}
        </ScrollView>
      </View>

      {/* ── Payouts list ── */}
      {loading ? (
        <View style={[styles.centerState, isWideWeb && styles.wideColumn]}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : error ? (
        <View style={[styles.emptyState, isWideWeb && styles.wideColumn]}>
          <View style={styles.emptyIconCircle}>
            <Ionicons name="cloud-offline-outline" size={28} color={Colors.primary} />
          </View>
          <Text style={styles.emptyTitle}>Couldn’t load payouts</Text>
          <Text style={styles.emptySubtitle}>Please check your connection and try again.</Text>
          <TouchableOpacity
            style={styles.retryBtnState}
            onPress={() => setReloadKey(k => k + 1)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text style={styles.retryBtnStateText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => item.id}
          renderItem={({ item }) => (
            <WithdrawalRow
              item={item}
              onApprove={setApprovalTarget}
              onReject={handleRejectOpen}
              onRetry={handleRetryOpen}
              stillConfirming={confirmingIds.has(item.id)}
            />
          )}
          contentContainerStyle={[styles.listContent, isWideWeb && styles.wideColumn]}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <View style={styles.emptyIconCircle}>
                <Ionicons name="arrow-up-circle-outline" size={28} color={Colors.primary} />
              </View>
              <Text style={styles.emptyTitle}>No payouts</Text>
              <Text style={styles.emptySubtitle}>
                {statusFilter === 'ALL'
                  ? 'No payout requests have been submitted yet.'
                  : `No ${STATUS_LABELS[statusFilter].toLowerCase()} payouts.`}
              </Text>
            </View>
          }
        />
      )}

      {/* ── Approve dialog ── */}
      {approvalTarget ? (
        <DisbursementApprovalDialog
          visible={approvalTarget !== null}
          withdrawalId={approvalTarget.id}
          amount={approvalTarget.amount}
          destinationPhone={approvalTarget.destinationPhone}
          destinationName={approvalTarget.destinationName}
          campaignTitle={approvalTarget.campaignTitle}
          submitting={approveSubmitting}
          onConfirm={handleApproveConfirm}
          onCancel={() => { if (!approveSubmitting) setApprovalTarget(null); }}
        />
      ) : null}

      {/* ── Approve error toast-style banner ── */}
      {approveError ? (
        <View style={styles.approveErrorBanner}>
          <Ionicons name="alert-circle-outline" size={16} color={Colors.white} />
          <Text style={styles.approveErrorText} numberOfLines={2}>{approveError}</Text>
          <TouchableOpacity onPress={() => setApproveError(null)} accessibilityRole="button" accessibilityLabel="Dismiss">
            <Ionicons name="close" size={16} color={Colors.white} />
          </TouchableOpacity>
        </View>
      ) : null}

      {/* ── Retry confirm modal — re-sends real money, so requires an explicit confirm ── */}
      <Modal
        visible={retryTarget !== null}
        title="Retry Payout"
        confirmLabel={retrySubmitting ? 'Dispatching…' : 'Retry Payout'}
        cancelLabel="Cancel"
        onConfirm={handleRetryConfirm}
        onCancel={() => { if (!retrySubmitting) setRetryTarget(null); }}
        confirmDisabled={retrySubmitting}
      >
        {retryTarget ? (
          <>
            <Text style={styles.retryConfirmTitle} numberOfLines={1}>{retryTarget.campaignTitle}</Text>
            <Text style={styles.retryConfirmAmount}>{fmtKes(retryTarget.amount)}</Text>
            <Text style={styles.retryConfirmPhone}>
              To: {retryTarget.destinationPhone} ({retryTarget.destinationName})
            </Text>
            <Text style={styles.retryConfirmWarning}>
              This will RE-SEND an M-Pesa payout to this number.
            </Text>
            {retryError ? <Text style={styles.retryConfirmError}>{retryError}</Text> : null}
          </>
        ) : null}
      </Modal>

      {/* ── Reject modal ── */}
      <ResponsiveSheet
        visible={rejectTarget !== null}
        onRequestClose={() => setRejectTarget(null)}
        keyboardOffset={kbOffset}
      >
          <View style={styles.pickerHandle} />
          <Text style={styles.rejectSheetTitle}>Reject Payout</Text>
          {rejectTarget ? (
            <Text style={styles.rejectSheetMeta}>
              {rejectTarget.campaignTitle} · {fmtKes(rejectTarget.amount)}
            </Text>
          ) : null}
          <Text style={styles.rejectInputLabel}>
            Reason for rejection <Text style={styles.required}>*</Text>
          </Text>
          <TextInput
            style={[styles.rejectInput, rejectAttempted && rejectReason.trim().length < 5 && styles.rejectInputError]}
            value={rejectReason}
            onChangeText={t => {
              setRejectReason(t);
              if (rejectAttempted) setRejectAttempted(false);
              if (rejectApiError) setRejectApiError(null);
            }}
            placeholder="Explain why this payout is being rejected…"
            placeholderTextColor={Colors.textMuted}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            accessibilityLabel="Rejection reason"
            editable={!rejectSubmitting}
          />
          {rejectAttempted && rejectReason.trim().length < 5 ? (
            <Text style={styles.rejectError}>Reason must be at least 5 characters.</Text>
          ) : null}
          {rejectApiError ? (
            <Text style={styles.rejectError}>{rejectApiError}</Text>
          ) : null}
          <View style={styles.rejectActions}>
            <TouchableOpacity
              style={styles.rejectCancelBtn}
              onPress={() => setRejectTarget(null)}
              activeOpacity={0.8}
              disabled={rejectSubmitting}
            >
              <Text style={styles.rejectCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.rejectSubmitBtn, rejectSubmitting && styles.rejectSubmitBtnDisabled]}
              onPress={handleRejectSubmit}
              activeOpacity={0.8}
              disabled={rejectSubmitting}
              accessibilityRole="button"
              accessibilityLabel="Submit rejection"
            >
              {rejectSubmitting ? (
                <ActivityIndicator size="small" color={Colors.white} />
              ) : (
                <Text style={styles.rejectSubmitText}>Submit</Text>
              )}
            </TouchableOpacity>
          </View>
      </ResponsiveSheet>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.surfaceSubtle,
  },

  // Wide-web (≥768) only — filter bar, states, and list content share one
  // centered 760 column.
  wideColumn: {
    maxWidth: 760,
    width: '100%',
    alignSelf: 'center',
  },

  filterBar: {
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
    paddingBottom: 8,
  },
  pendingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.accentLight,
    borderRadius: BorderRadius.lg,
    marginHorizontal: Spacing.md,
    marginTop: 10,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    gap: 10,
  },
  pendingIconCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  pendingBannerText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.accentDark,
    flex: 1,
  },
  chipsScroll: {
    paddingHorizontal: Spacing.md,
    paddingTop: 10,
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    backgroundColor: Colors.surfaceSubtle,
  },
  filterChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  filterChipText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
  },
  filterChipTextActive: {
    color: Colors.white,
  },

  listContent: {
    padding: Spacing.md,
    paddingBottom: Spacing.xl,
  },
  separator: {
    height: Spacing.sm,
  },

  row: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    padding: Spacing.md,
    ...Shadows.sm,
  },
  rowDanger: {
    borderColor: Colors.danger,
    backgroundColor: Colors.dangerLight,
  },
  investigationBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.dangerLight,
    borderRadius: BorderRadius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 10,
  },
  investigationText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.xs,
    color: Colors.danger,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  rowLeft: {
    flex: 1,
    gap: 3,
  },
  campaignTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.text,
  },
  rowReason: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 18,
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 2,
  },
  rowPhone: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  rowDot: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  rowDate: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  rowRight: {
    alignItems: 'flex-end',
    gap: 6,
    flexShrink: 0,
  },
  amount: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.text,
  },

  statusBadge: {
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  statusBadgeText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: 10,
  },

  confirmingNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.sm,
    padding: Spacing.sm,
  },
  confirmingNoteText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.primary,
  },
  rejectionNote: {
    marginTop: 10,
    backgroundColor: Colors.grey,
    borderRadius: BorderRadius.sm,
    padding: Spacing.sm,
  },
  rejectionLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginBottom: 2,
  },
  rejectionText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  failureNote: {
    marginTop: 10,
    backgroundColor: Colors.dangerLight,
    borderRadius: BorderRadius.sm,
    padding: Spacing.sm,
    gap: 2,
  },
  failureText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.danger,
  },
  retryCount: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.danger,
  },

  actionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.borderLight,
  },
  approveBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 42,
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.pill,
    gap: 6,
  },
  approveBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.sm,
    color: Colors.white,
  },
  rejectBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 42,
    borderWidth: 1.5,
    borderColor: Colors.danger,
    borderRadius: BorderRadius.pill,
    gap: 6,
    backgroundColor: Colors.white,
  },
  rejectBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.sm,
    color: Colors.danger,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 42,
    paddingHorizontal: 20,
    borderWidth: 1.5,
    borderColor: Colors.warning,
    borderRadius: BorderRadius.pill,
    gap: 6,
    backgroundColor: Colors.warningLight,
  },
  retryBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.sm,
    color: Colors.warning,
  },

  retryConfirmTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.text,
    marginBottom: 4,
  },
  retryConfirmAmount: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.text,
    marginBottom: 8,
  },
  retryConfirmPhone: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: 8,
  },
  retryConfirmWarning: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.warning,
  },
  retryConfirmError: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.danger,
    marginTop: 8,
  },

  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: 60,
    gap: Spacing.sm,
  },
  emptyIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
    marginTop: Spacing.sm,
  },
  emptySubtitle: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: Spacing.xl,
  },
  retryBtnState: {
    marginTop: Spacing.md,
    paddingHorizontal: Spacing.xl,
    height: Spacing.touch,
    borderRadius: BorderRadius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryBtnStateText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.white,
  },

  approveErrorBanner: {
    position: 'absolute',
    left: Spacing.md,
    right: Spacing.md,
    bottom: Spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.danger,
    borderRadius: BorderRadius.lg,
    padding: Spacing.sm + 2,
    ...Shadows.lg,
  },
  approveErrorText: {
    flex: 1,
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.white,
  },

  // Reject modal
  // Reject modal container/overlay/sheet now come from ResponsiveSheet.
  pickerHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: 'center',
    marginBottom: Spacing.sm,
  },
  rejectSheetTitle: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.text,
  },
  rejectSheetMeta: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  rejectInputLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  required: {
    color: Colors.danger,
  },
  rejectInput: {
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: BorderRadius.lg,
    padding: Spacing.sm + 2,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.text,
    minHeight: 100,
    textAlignVertical: 'top',
  },
  rejectInputError: {
    borderColor: Colors.danger,
  },
  rejectError: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.danger,
  },
  rejectActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: 4,
  },
  rejectCancelBtn: {
    flex: 1,
    height: 48,
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: BorderRadius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectCancelText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
  },
  rejectSubmitBtn: {
    flex: 1,
    height: 48,
    backgroundColor: Colors.danger,
    borderRadius: BorderRadius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectSubmitBtnDisabled: {
    opacity: 0.6,
  },
  rejectSubmitText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.white,
  },
});
