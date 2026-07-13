import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import {
  SUBSCRIPTION_GRACE_DAYS,
  SUBSCRIPTION_POLL_INTERVAL_MS,
  SUBSCRIPTION_POLL_MAX_ATTEMPTS,
} from '../../constants/subscription';
import { useFocusRefetch } from '../../hooks/useFocusRefetch';
import { churchesService } from '../../services/churches.service';
import { subscriptionsService } from '../../services/subscriptions.service';
import { SubscriptionTier } from '../../types';
import { formatDate } from '../../utils/formatters';
import { SubscriptionState, deriveSubscriptionState, getValidTiers, pollReducer } from '../../utils/subscription';
import Badge from '../ui/Badge';
import Card from '../ui/Card';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import Spinner from '../ui/Spinner';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Whole days from `now` to a target ms, ROUNDED (never a fractional "2.4 days") and
// clamped at 0 (a target already reached reads as 0 → "today", handled by the callers).
function wholeDaysUntil(now: Date, targetMs: number): number {
  return Math.max(0, Math.round((targetMs - now.getTime()) / MS_PER_DAY));
}

function dayCountLabel(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

// ─── Per-state visual spec (owned by the UI/UX layer) ─────────────────────────
// Color is NEVER the only signal — each state pairs its accent with an icon + copy.
// Button hierarchy: ACTIVE is low-urgency (outlined, "manage"); the action-needed
// states are filled CTAs (accent orange for renew/upgrade, danger red at peak urgency).

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

interface StateVisual {
  icon: IoniconName;
  accent: string;
  tintBg: string | null;      // null = neutral (plain row, no tinted attention block)
  buttonLabel: string;
  buttonFilled: boolean;
  buttonColor: string;        // fill (filled) OR border+text (outlined)
}

const STATE_VISUAL: Record<SubscriptionState, StateVisual> = {
  ACTIVE: {
    icon: 'checkmark-circle',
    accent: Colors.success,
    tintBg: null,
    buttonLabel: 'Manage subscription',
    buttonFilled: false,
    buttonColor: Colors.primary,
  },
  EXPIRING_SOON: {
    icon: 'time-outline',
    accent: Colors.warning,
    tintBg: Colors.warningLight,
    buttonLabel: 'Renew now',
    buttonFilled: true,
    buttonColor: Colors.accent,
  },
  IN_GRACE: {
    icon: 'alert-circle',
    accent: Colors.danger,
    tintBg: Colors.dangerLight,
    buttonLabel: 'Renew now',
    buttonFilled: true,
    buttonColor: Colors.danger,
  },
  FREE: {
    icon: 'arrow-up-circle-outline',
    accent: Colors.textMuted,
    tintBg: null,
    buttonLabel: 'Upgrade plan',
    buttonFilled: true,
    buttonColor: Colors.accent,
  },
  // CANCELLED is an OVERLAY (auto-renew opted out on a still-paid plan): neutral grey
  // attention block, but the renew CTA stays so the church can re-subscribe (a paid
  // renewal clears the cancellation server-side).
  CANCELLED: {
    icon: 'close-circle-outline',
    accent: Colors.textSecondary,
    tintBg: Colors.grey,
    buttonLabel: 'Renew now',
    buttonFilled: true,
    buttonColor: Colors.accent,
  },
};

// Per-tier picker copy. Price is NOT shown — there is no treasurer-readable price source
// (PlatformSettings is super-admin only) and a hardcoded number would go stale; the live
// amount appears on the M-Pesa STK prompt instead.
const TIER_META: Record<'GROWTH' | 'PARISH', { label: string; blurb: string }> = {
  GROWTH: { label: 'Growth', blurb: 'Unlimited active campaigns and more' },
  PARISH: { label: 'Parish', blurb: 'For larger churches — everything in Growth' },
};

// Per-state message. Day counts are whole + rounded; a 0-day boundary reads "today".
function buildMessage(state: SubscriptionState, expiresAt: string | undefined, now: Date): string {
  if (state === 'FREE' || !expiresAt) {
    return 'Up to 3 active campaigns. Upgrade to Growth or Parish for unlimited campaigns and more.';
  }
  const expiryMs = new Date(expiresAt).getTime();
  const date = formatDate(expiresAt);

  if (state === 'CANCELLED') {
    // Auto-renew is off; the church keeps its paid plan until expiry, then lapses to Free.
    return `Cancelled — active until ${date}, then reverts to Free.`;
  }
  if (state === 'ACTIVE') {
    const left = wholeDaysUntil(now, expiryMs);
    return `Renews on ${date} · ${dayCountLabel(left)} left`;
  }
  if (state === 'EXPIRING_SOON') {
    const left = wholeDaysUntil(now, expiryMs);
    const when = left <= 0 ? 'today' : `in ${dayCountLabel(left)}`;
    return `Expires ${when}, on ${date}. Renew to keep your campaigns running.`;
  }
  // IN_GRACE: countdown is to the lapse date (expiry + grace window), not to expiry.
  const lapseMs = expiryMs + SUBSCRIPTION_GRACE_DAYS * MS_PER_DAY;
  const toLapse = wholeDaysUntil(now, lapseMs);
  const when = toLapse <= 0 ? 'today' : `in ${dayCountLabel(toLapse)}`;
  return `Your plan expired. You drop to Free ${when} unless you renew — new campaigns are capped at 3.`;
}

// Default the phone field to the church's own number in familiar local (07xx) form so it
// passes validatePhone — the stored value may be in 254XXXXXXXXX / +254 form.
function toLocalPhone(p: string): string {
  const d = p.replace(/[\s-]/g, '');
  if (d.startsWith('+254')) return '0' + d.slice(4);
  if (d.startsWith('254')) return '0' + d.slice(3);
  return d;
}

// Client-side phone check (clone of DonationForm.validatePhone) — fail fast before the
// initiate call; the backend re-validates + normalizes (it is the source of truth).
function validatePhone(v: string): string | undefined {
  const d = v.replace(/\s/g, '');
  if (!d) return 'Phone number is required';
  if (!/^(07|01)\d{8}$/.test(d)) return 'Enter a valid Kenyan number, e.g. 0712 345 678';
}

// Pull a human detail string out of a DRF error body ({"detail": "..."}).
function extractDetail(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'detail' in data) {
    const d = (data as { detail?: unknown }).detail;
    if (typeof d === 'string') return d;
  }
  return undefined;
}

// Pull a DRF field error ({"phone_number": ["..."]}) — the shape the required-phone 400
// uses (no top-level `detail`).
function pickFieldError(data: unknown, field: string): string | undefined {
  if (data && typeof data === 'object' && field in data) {
    const v = (data as Record<string, unknown>)[field];
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

// Classify an initiate failure to a copy line (clone of the donation form's mapping).
// 200 is success (handled by the caller); these are the propagated error statuses.
function classifyInitiateError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data;
    if (status === 502) {
      return "We couldn't start the M-Pesa payment. You have not been charged — please try again.";
    }
    if (status === 429) {
      return 'Too many attempts from this number. Please wait a while and try again.';
    }
    if (status === 409) {
      return extractDetail(data) ?? 'A subscription payment is already in progress.';
    }
    if (status === 400 || status === 404) {
      // Field-keyed phone error (required/invalid) OR a {detail:...} 400 (FREE target,
      // Parish→Growth down-pay block). Both render as a single failure line.
      return pickFieldError(data, 'phone_number')
        ?? extractDetail(data)
        ?? 'This payment could not be started. Please try again.';
    }
  }
  return 'Something went wrong starting your payment. Please try again.';
}

// 'idle'        = showing the current plan
// 'submitting'  = initiate request in flight (primary button busy)
// 'confirming'  = initiate 200 (STK prompt SENT, status PENDING); polling for the PIN verdict
// 'success'     = a SUCCESSFUL poll verdict — the ONLY trigger for a success claim
// 'failed'      = a FAILED poll verdict, OR an initiate/cancel error
// 'unconfirmed' = poll bound exhausted (or stale-while-PENDING) — honest unknown, no claim
type FlowState = 'idle' | 'submitting' | 'confirming' | 'success' | 'failed' | 'unconfirmed';

// ─── Card ─────────────────────────────────────────────────────────────────────

export default function SubscriptionCard() {
  const { data: church, status, refetchError, retry } = useFocusRefetch(
    () => churchesService.getMyChurch(),
  );

  const [pickerOpen, setPickerOpen] = useState(false);
  // null = the tier-list step; a tier = the phone-entry step (pick tier → phone field shows).
  const [selectedTier, setSelectedTier] = useState<SubscriptionTier | null>(null);
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string | undefined>(undefined);
  const [flowState, setFlowState] = useState<FlowState>('idle');
  const [failedMessage, setFailedMessage] = useState('Please try again.');
  const [cancelling, setCancelling] = useState(false);
  // Captured from a SUCCESSFUL poll verdict — drives the "on {tier} until {expiry}" copy.
  const [successInfo, setSuccessInfo] = useState<{ tier: SubscriptionTier; expiresAt: string | null } | null>(null);

  // Poll bookkeeping (clone of DonationForm). settledRef guarantees a late poll response
  // can never override a terminal already shown; mountedRef + clearTimer prevent
  // setState-after-unmount and leaked timers.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const settledRef = useRef(false);
  const mountedRef = useRef(true);

  const clearTimer = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Guard async setState after unmount; clear any in-flight poll timer (no leak).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  // Poll GET /subscriptions/{id}/status/ every INTERVAL, up to MAX_ATTEMPTS. The pure
  // pollReducer decides each tick; settledRef + clearTimer make terminals stick and stop
  // the timer. A network blip / 404 is swallowed (verdict null) and counts as a
  // non-terminal attempt — exactly the donation poll's behaviour.
  const startPoll = useCallback((paymentId: string) => {
    attemptsRef.current = 0;
    const tick = async () => {
      attemptsRef.current += 1;
      let verdict: Awaited<ReturnType<typeof subscriptionsService.getStatus>> | null = null;
      try {
        verdict = await subscriptionsService.getStatus(paymentId);
      } catch {
        verdict = null;   // blip / transient 404 — non-terminal, keep polling
      }
      if (!mountedRef.current || settledRef.current) return;

      const outcome = pollReducer('confirming', {
        verdict,
        attempts: attemptsRef.current,
        maxAttempts: SUBSCRIPTION_POLL_MAX_ATTEMPTS,
      });

      if (outcome.state === 'success') {
        settledRef.current = true;
        clearTimer();
        setSuccessInfo(outcome.success ?? null);
        setFlowState('success');
        retry();   // refetch the card so it shows the new ACTIVE tier/expiry behind the terminal
        return;
      }
      if (outcome.state === 'failed') {
        settledRef.current = true;
        clearTimer();
        setFailedMessage("Payment didn't go through. Try again.");
        setFlowState('failed');
        return;
      }
      if (outcome.state === 'unconfirmed') {
        settledRef.current = true;
        clearTimer();
        setFlowState('unconfirmed');
        return;
      }
      // 'confirming' → keep polling until a terminal or the bound.
      pollTimerRef.current = setTimeout(tick, SUBSCRIPTION_POLL_INTERVAL_MS);
    };
    pollTimerRef.current = setTimeout(tick, SUBSCRIPTION_POLL_INTERVAL_MS);
  }, [clearTimer, retry]);

  // Return to the live card from any terminal — stop the timer, drop the settled latch,
  // clear the picker step. The refetched card (retry on success) shows the new state.
  function resetToIdle() {
    clearTimer();
    settledRef.current = false;
    setSelectedTier(null);
    setSuccessInfo(null);
    setFlowState('idle');
  }

  // First focus, nothing cached yet → spinner (reserves height so the card doesn't jump).
  if (church === null && status === 'loading') {
    return (
      <Card style={styles.card}>
        <View style={styles.stateBox}>
          <Spinner size="small" />
          <Text style={styles.mutedNote}>Loading subscription…</Text>
        </View>
      </Card>
    );
  }

  // First focus FAILED with nothing to fall back to → error + retry (no blank card).
  if (church === null) {
    return (
      <Card style={styles.card}>
        <View style={styles.stateBox}>
          <Ionicons name="cloud-offline-outline" size={22} color={Colors.textMuted} />
          <Text style={styles.mutedNote}>Couldn&apos;t load your subscription.</Text>
          <TouchableOpacity
            onPress={retry}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Retry loading subscription"
          >
            <Text style={styles.retryLink}>Retry</Text>
          </TouchableOpacity>
        </View>
      </Card>
    );
  }

  const now = new Date();
  // Base lifecycle state (never CANCELLED) drives the tier rule; the CANCELLED OVERLAY is
  // layered only when auto-renew is off AND the plan is still paid (base !== FREE).
  const baseState = deriveSubscriptionState(church.subscriptionTier, church.subscriptionExpiresAt, now);
  const isPaidPlan = baseState !== 'FREE';
  const cancelled = !!church.subscriptionCancelRequested && isPaidPlan;
  const state: SubscriptionState = cancelled ? 'CANCELLED' : baseState;

  const visual = STATE_VISUAL[state];
  const message = buildMessage(state, church.subscriptionExpiresAt, now);
  // In FREE state we present the plan AS Free even if the backend tier hasn't flipped yet
  // (lapsed-beyond-grace) — never imply a paid tier the backend is about to revoke.
  const badgeTier = state === 'FREE' ? 'FREE' : church.subscriptionTier;
  // The picker offers ONLY what the backend will accept (the shared tier rule).
  const validTiers = getValidTiers(baseState, church.subscriptionTier, church.subscriptionExpiresAt, now);

  // ── Open the picker fresh: tier-list step, phone defaulted to the church's own number. ──
  function openPicker() {
    setSelectedTier(null);
    setPhone(toLocalPhone(church?.phone ?? ''));
    setPhoneError(undefined);
    setPickerOpen(true);
  }

  // ── Pick a tier → move to the phone-entry step (does NOT fire initiate yet). ──
  function handlePickTier(tier: SubscriptionTier) {
    setPhoneError(undefined);
    setSelectedTier(tier);
  }

  // ── Confirm the phone → validate client-side, then fire the real initiate. 200 = STK
  // prompt sent (NOT yet active). An invalid phone keeps the picker open with the error. ──
  async function handleConfirmPhone() {
    if (selectedTier === null) return;
    const err = validatePhone(phone);
    if (err) {
      setPhoneError(err);
      return;
    }
    const tier = selectedTier;
    const phoneToSend = phone.replace(/\s/g, '');
    setPickerOpen(false);
    setSelectedTier(null);
    clearTimer();
    settledRef.current = false;
    setFlowState('submitting');

    let res;
    try {
      res = await subscriptionsService.initiate({ tier, phone_number: phoneToSend });
    } catch (e) {
      if (!mountedRef.current) return;
      setFailedMessage(classifyInitiateError(e));
      setFlowState('failed');
      return;
    }
    if (!mountedRef.current) return;
    // 200 = STK prompt SENT (status PENDING). We DO NOT claim success — poll for the verdict.
    setFlowState('confirming');
    startPoll(res.subscriptionPaymentId);
  }

  // ── Cancel auto-renew → refetch so the flag (now true) flips the card to CANCELLED. ──
  async function handleCancel() {
    setCancelling(true);
    try {
      await subscriptionsService.cancel();
    } catch {
      if (!mountedRef.current) return;
      setCancelling(false);
      setFailedMessage("We couldn't cancel auto-renew. Please try again.");
      setFlowState('failed');
      return;
    }
    if (!mountedRef.current) return;
    setCancelling(false);
    retry();   // background refetch — picks up subscription_cancel_requested = true
  }

  // ── Confirming (STK sent — polling for the PIN verdict; spinner, no button) ─────
  if (flowState === 'confirming') {
    return (
      <Card style={styles.card}>
        <View style={styles.requestedBox}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.requestedHeading}>Check your phone</Text>
          <Text style={styles.requestedNote}>
            Enter your M-Pesa PIN to complete the payment. This can take a few moments…
          </Text>
        </View>
      </Card>
    );
  }

  // ── Success (driven ONLY by a SUCCESSFUL poll verdict) ─────────────────────────
  if (flowState === 'success') {
    const paidTier = successInfo?.tier ?? church.subscriptionTier;
    const tierLabel = TIER_META[paidTier as 'GROWTH' | 'PARISH']?.label ?? paidTier;
    return (
      <Card style={styles.card}>
        <View style={[styles.tintBlock, { backgroundColor: Colors.successLight, borderLeftColor: Colors.success }]}>
          <Ionicons name="checkmark-circle" size={18} color={Colors.success} style={styles.msgIcon} />
          <Text style={[styles.message, { color: Colors.success }]}>
            {successInfo?.expiresAt
              ? `You're on ${tierLabel} until ${formatDate(successInfo.expiresAt)}.`
              : `You're on ${tierLabel}.`}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.button, { backgroundColor: Colors.primary }]}
          onPress={resetToIdle}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Done"
        >
          <Text style={[styles.buttonText, { color: Colors.white }]}>Done</Text>
        </TouchableOpacity>
      </Card>
    );
  }

  // ── Failed (poll FAILED, or initiate/cancel error) ─────────────────────────────
  if (flowState === 'failed') {
    return (
      <Card style={styles.card}>
        <View style={[styles.tintBlock, { backgroundColor: Colors.dangerLight, borderLeftColor: Colors.danger }]}>
          <Ionicons name="alert-circle" size={18} color={Colors.danger} style={styles.msgIcon} />
          <Text style={[styles.message, { color: Colors.danger }]}>{failedMessage}</Text>
        </View>
        <TouchableOpacity
          style={[styles.button, { borderWidth: 1.5, borderColor: Colors.primary }]}
          onPress={resetToIdle}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Text style={[styles.buttonText, { color: Colors.primary }]}>Back</Text>
        </TouchableOpacity>
      </Card>
    );
  }

  // ── Unconfirmed (poll bound expired while PENDING — the honest unknown) ─────────
  if (flowState === 'unconfirmed') {
    return (
      <Card style={styles.card}>
        <View style={[styles.tintBlock, { backgroundColor: Colors.warningLight, borderLeftColor: Colors.warning }]}>
          <Ionicons name="time-outline" size={18} color={Colors.warning} style={styles.msgIcon} />
          <Text style={[styles.message, { color: Colors.warning }]}>
            We couldn&apos;t confirm yet. If money left your M-Pesa, it&apos;s safe — you&apos;ll
            get an SMS. Otherwise try again.
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.button, { borderWidth: 1.5, borderColor: Colors.primary }]}
          onPress={resetToIdle}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Done"
        >
          <Text style={[styles.buttonText, { color: Colors.primary }]}>Done</Text>
        </TouchableOpacity>
      </Card>
    );
  }

  const submitting = flowState === 'submitting';

  return (
    <Card style={styles.card}>
      <View style={styles.headerRow}>
        <Badge status={badgeTier} label={badgeTier} />
      </View>

      {visual.tintBg ? (
        // Attention states (EXPIRING_SOON / IN_GRACE / CANCELLED): tinted block, accent edge.
        <View style={[styles.tintBlock, { backgroundColor: visual.tintBg, borderLeftColor: visual.accent }]}>
          <Ionicons name={visual.icon} size={18} color={visual.accent} style={styles.msgIcon} />
          <Text style={[styles.message, { color: visual.accent }]}>{message}</Text>
        </View>
      ) : (
        // Neutral states (ACTIVE / FREE): plain row, accent icon, secondary text.
        <View style={styles.plainRow}>
          <Ionicons name={visual.icon} size={18} color={visual.accent} style={styles.msgIcon} />
          <Text style={[styles.message, styles.messageNeutral]}>{message}</Text>
        </View>
      )}

      <TouchableOpacity
        style={[
          styles.button,
          visual.buttonFilled
            ? { backgroundColor: visual.buttonColor }
            : { borderWidth: 1.5, borderColor: visual.buttonColor },
          submitting && styles.buttonBusy,
        ]}
        onPress={openPicker}
        disabled={submitting}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={visual.buttonLabel}
        accessibilityState={{ busy: submitting, disabled: submitting }}
      >
        {submitting ? (
          <ActivityIndicator size="small" color={visual.buttonFilled ? Colors.white : visual.buttonColor} />
        ) : (
          <Text
            style={[
              styles.buttonText,
              { color: visual.buttonFilled ? Colors.white : visual.buttonColor },
            ]}
          >
            {visual.buttonLabel}
          </Text>
        )}
      </TouchableOpacity>

      {/* Cancel auto-renew — only on a paid plan that is NOT already cancelled. */}
      {isPaidPlan && !cancelled ? (
        <TouchableOpacity
          style={styles.cancelLink}
          onPress={handleCancel}
          disabled={cancelling || submitting}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Cancel auto-renew"
          accessibilityState={{ busy: cancelling, disabled: cancelling || submitting }}
        >
          {cancelling ? (
            <ActivityIndicator size="small" color={Colors.textMuted} />
          ) : (
            <Text style={styles.cancelLinkText}>Cancel auto-renew</Text>
          )}
        </TouchableOpacity>
      ) : null}

      {/* Background refetch failed but we kept last-good data — subtle, non-blocking. */}
      {refetchError ? (
        <View style={styles.refetchRow}>
          <Text style={styles.refetchText}>Couldn&apos;t refresh.</Text>
          <TouchableOpacity
            onPress={retry}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Retry refreshing subscription"
          >
            <Text style={styles.retryLink}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Tier picker — step 1: choose a tier (offers ONLY getValidTiers). Step 2: enter
          the M-Pesa number to charge (defaulted to the church's own), then submit fires
          initiate. */}
      <Modal
        visible={pickerOpen}
        title={selectedTier ? `Pay for ${TIER_META[selectedTier as 'GROWTH' | 'PARISH'].label}` : 'Choose a plan'}
        confirmLabel="Send M-Pesa prompt"
        confirmVariant="cta"
        onConfirm={selectedTier ? handleConfirmPhone : undefined}
        cancelLabel={selectedTier ? 'Back' : 'Cancel'}
        onCancel={selectedTier ? () => setSelectedTier(null) : () => setPickerOpen(false)}
      >
        {selectedTier ? (
          // ── Step 2: phone entry ──────────────────────────────────────────────────
          <View>
            <Text style={styles.phoneLead}>
              Enter the M-Pesa number to charge. You can change it from your default below.
            </Text>
            <Input
              label="M-Pesa number"
              keyboardType="phone-pad"
              placeholder="e.g. 0712 345 678"
              value={phone}
              onChangeText={(v) => { setPhone(v); if (phoneError) setPhoneError(undefined); }}
              error={phoneError}
              autoFocus
            />
            <Text style={styles.pickerNote}>
              You&apos;ll get an M-Pesa prompt on this number for the current monthly rate.
              Enter your PIN to pay.
            </Text>
          </View>
        ) : (
          // ── Step 1: tier list ────────────────────────────────────────────────────
          <View>
            {validTiers.map((t) => {
              const meta = TIER_META[t as 'GROWTH' | 'PARISH'];
              return (
                <TouchableOpacity
                  key={t}
                  style={styles.tierRow}
                  onPress={() => handlePickTier(t)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Choose the ${meta.label} plan`}
                >
                  <View style={styles.tierRowText}>
                    <Text style={styles.tierLabel}>{meta.label}</Text>
                    <Text style={styles.tierBlurb}>{meta.blurb}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={Colors.textMuted} />
                </TouchableOpacity>
              );
            })}
            <Text style={styles.pickerNote}>
              You&apos;ll get an M-Pesa prompt for the current monthly rate. Enter your PIN to pay.
            </Text>
          </View>
        )}
      </Modal>
    </Card>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: { marginBottom: 0 },

  // Loading / error placeholder — reserves vertical space to avoid a layout jump.
  stateBox: {
    minHeight: 96,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
  },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },

  // Attention (tinted) message block.
  tintBlock: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    borderRadius: BorderRadius.lg,
    borderLeftWidth: 3,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.md,
  },
  // Neutral message row.
  plainRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
    paddingHorizontal: 2,
  },
  msgIcon: { marginTop: 1 },
  message: {
    flex: 1,
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    lineHeight: FontSize.sm * 1.5,
  },
  messageNeutral: {
    fontFamily: 'Poppins-Regular',
    color: Colors.textSecondary,
  },

  button: {
    height: Spacing.touch,
    borderRadius: BorderRadius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonBusy: { opacity: 0.7 },
  buttonText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
  },

  // Cancel auto-renew — subtle, low-emphasis text button under the primary CTA.
  cancelLink: {
    height: Spacing.touch,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.xs,
  },
  cancelLinkText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },

  // Requested (STK sent) confirmation block.
  requestedBox: {
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    alignItems: 'center',
    gap: 4,
  },
  requestedHeading: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.primary,
    marginTop: 2,
  },
  requestedNote: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: FontSize.sm * 1.5,
  },

  // Tier picker rows (inside the Modal body).
  tierRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    minHeight: Spacing.touch + 8,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    borderRadius: BorderRadius.lg,
    marginBottom: Spacing.sm,
    backgroundColor: Colors.white,
  },
  tierRowText: { flex: 1 },
  tierLabel: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.base,
    color: Colors.text,
  },
  tierBlurb: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    marginTop: 1,
  },
  pickerNote: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    lineHeight: FontSize.xs * 1.6,
    marginTop: 4,
  },
  phoneLead: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: FontSize.sm * 1.5,
    marginBottom: Spacing.md,
  },

  mutedNote: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  retryLink: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },

  refetchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    marginTop: Spacing.md,
  },
  refetchText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
});
