import axios from 'axios';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { donationsService } from '../../services/donations.service';

interface DonationFormProps {
  campaignSlug: string;
  campaignTitle: string;
}

// 'submitting'  = initiate request in flight
// 'confirming'  = STK prompt sent (status PENDING); polling for the donor's PIN verdict
// 'success'     = a SUCCESSFUL poll verdict — the ONLY trigger for success
// 'failed'      = a FAILED poll verdict, OR a 502/429/400-detail/404 from initiate
// 'unconfirmed' = poll bound expired while still PENDING — UNKNOWN, money may or may
//                 not have moved (never claim success OR failure here)
type DonationState = 'idle' | 'submitting' | 'confirming' | 'success' | 'failed' | 'unconfirmed';

// Poll bound — a UX/Daraja-latency tradeoff, tunable after observing real sandbox
// latency. ~30s ceiling (10 × 3s) before we fall back to the honest 'unconfirmed'
// terminal rather than spinning forever on a PENDING-that-won't-resolve.
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 10;

function validatePhone(v: string): string | undefined {
  const d = v.replace(/\s/g, '');
  if (!d) return 'Phone number is required';
  if (!/^(07|01)\d{8}$/.test(d)) return 'Enter a valid Kenyan number, e.g. 0712 345 678';
}

function validateAmount(v: string): string | undefined {
  if (!v) return 'Amount is required';
  const n = Number(v);
  if (isNaN(n) || n < 5) return 'Minimum amount is KES 5';
}

// Pull a human detail string out of a DRF error body ({"detail": "..."}).
function extractDetail(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'detail' in data) {
    const d = (data as { detail?: unknown }).detail;
    if (typeof d === 'string') return d;
  }
  return undefined;
}

export default function DonationForm({ campaignSlug, campaignTitle: _campaignTitle }: DonationFormProps) {
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [donorName, setDonorName] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<{ phone?: string; amount?: string }>({});
  const [donationState, setDonationState] = useState<DonationState>('idle');
  // Captured from a SUCCESSFUL poll: GROSS amount + the REAL receipt (the donor-success
  // screen shows GROSS — the Net-Everywhere exception).
  const [result, setResult] = useState<{ amount: number; receipt: string | null } | null>(null);
  // Copy for the 'failed' terminal (poll-declined vs initiate failure).
  const [failedMessage, setFailedMessage] = useState('Please try again.');

  // Poll bookkeeping. settledRef guarantees a late poll response can never override a
  // terminal state already shown; mountedRef + clearTimer prevent setState-after-unmount
  // and leaked timers.
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  function clearError(field: 'phone' | 'amount') {
    if (errors[field]) setErrors(e => ({ ...e, [field]: undefined }));
  }

  // Full reset (clears inputs) — used after success and from the unconfirmed terminal,
  // where re-using the same inputs risks an accidental double-donation.
  function reset() {
    clearTimer();
    settledRef.current = false;
    setDonationState('idle');
    setPhone('');
    setAmount('');
    setDonorName('');
    setEmail('');
    setErrors({});
    setResult(null);
  }

  // Retry that KEEPS the inputs — used from the 'failed' terminal (nothing was charged
  // on a 502, or the donor was declined and wants to retry the same amount).
  function retryKeepInputs() {
    clearTimer();
    settledRef.current = false;
    setErrors({});
    setDonationState('idle');
  }

  // Poll GET /donations/{id}/status/ every POLL_INTERVAL_MS, up to POLL_MAX_ATTEMPTS.
  // SUCCESSFUL/FAILED are terminal (stop immediately). PENDING or a transient poll
  // error counts as a non-terminal attempt; when the bound is exhausted we land on
  // 'unconfirmed', NEVER 'failed'.
  const startPoll = useCallback((donationId: string) => {
    attemptsRef.current = 0;
    const tick = async () => {
      attemptsRef.current += 1;
      let verdict: Awaited<ReturnType<typeof donationsService.getDonationStatus>> | null = null;
      try {
        verdict = await donationsService.getDonationStatus(donationId);
      } catch {
        // Network blip / transient 404 — do NOT fail; count as a non-terminal attempt.
        verdict = null;
      }
      if (!mountedRef.current || settledRef.current) return;

      if (verdict && verdict.status === 'SUCCESSFUL') {
        settledRef.current = true;
        clearTimer();
        setResult({ amount: verdict.amount, receipt: verdict.mpesaReceiptNumber });
        setDonationState('success');
        return;
      }
      if (verdict && verdict.status === 'FAILED') {
        settledRef.current = true;
        clearTimer();
        setFailedMessage('Your M-Pesa payment was declined or cancelled. You have not been charged.');
        setDonationState('failed');
        return;
      }
      // PENDING (or transient blip) → keep polling until the bound.
      if (attemptsRef.current >= POLL_MAX_ATTEMPTS) {
        settledRef.current = true;
        clearTimer();
        setDonationState('unconfirmed');
        return;
      }
      pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
  }, [clearTimer]);

  // Map an initiate failure to a terminal. Field-keyed 400 (phone/amount) returns to
  // the form with inline errors; every other failure lands on 'failed' with copy.
  function handleInitiateError(err: unknown) {
    if (!mountedRef.current) return;
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const data = err.response?.data as Record<string, unknown> | undefined;

      if (status === 400 && data && (data.phone_number || data.amount)) {
        const phoneErr = Array.isArray(data.phone_number) ? String(data.phone_number[0]) : undefined;
        const amountErr = Array.isArray(data.amount) ? String(data.amount[0]) : undefined;
        setErrors({ phone: phoneErr, amount: amountErr });
        setDonationState('idle');   // correctable — stay on the form
        return;
      }
      if (status === 502) {
        // STK never queued — nothing was charged; safe to retry.
        setFailedMessage("We couldn't start the M-Pesa payment. You have not been charged — please try again.");
        setDonationState('failed');
        return;
      }
      if (status === 429) {
        setFailedMessage('Too many donation attempts from this number. Please wait a while and try again.');
        setDonationState('failed');
        return;
      }
      if (status === 400 || status === 404) {
        setFailedMessage(extractDetail(data) ?? 'This donation could not be started. Please try again.');
        setDonationState('failed');
        return;
      }
    }
    setFailedMessage('Something went wrong starting your donation. Please try again.');
    setDonationState('failed');
  }

  async function handleDonate() {
    const phoneErr = validatePhone(phone);
    const amountErr = validateAmount(amount);
    if (phoneErr || amountErr) {
      setErrors({ phone: phoneErr, amount: amountErr });
      return;
    }
    setErrors({});
    settledRef.current = false;
    setDonationState('submitting');

    let res;
    try {
      res = await donationsService.initiate({
        campaign_slug: campaignSlug,
        phone_number: phone.replace(/\s/g, ''),
        amount: Number(amount),
        donor_name: donorName || undefined,
        donor_email: email || undefined,
      });
    } catch (err) {
      handleInitiateError(err);
      return;
    }
    if (!mountedRef.current) return;
    // 200 = STK prompt SENT (status PENDING). The donor still has to enter their PIN.
    // We DO NOT claim success here — we begin polling for the real verdict.
    setDonationState('confirming');
    startPoll(res.donationId);
  }

  // ── Confirming (STK sent — polling for the PIN verdict) ────────────────────────
  if (donationState === 'confirming') {
    return (
      <View style={styles.card}>
        <View style={styles.confirmingBox}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.confirmingHeading}>Check your phone</Text>
          <Text style={styles.confirmingNote}>
            Enter your M-Pesa PIN to complete the donation. This can take a few moments…
          </Text>
        </View>
      </View>
    );
  }

  // ── Success (driven ONLY by a SUCCESSFUL poll verdict) ─────────────────────────
  if (donationState === 'success') {
    return (
      <View style={styles.card}>
        <View style={styles.successBox}>
          <Text style={styles.resultHeading}>Thank you!</Text>
          {result?.receipt ? (
            <Text style={styles.receiptText}>M-Pesa Receipt: {result.receipt}</Text>
          ) : null}
          <Text style={styles.resultNote}>
            Your donation of KES {(result?.amount ?? 0).toLocaleString()} has been received.
          </Text>
        </View>
        <TouchableOpacity
          style={styles.againBtn}
          onPress={reset}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Donate again"
        >
          <Text style={styles.againBtnText}>Donate Again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Failed (poll FAILED, or initiate 502/429/400-detail/404) ───────────────────
  if (donationState === 'failed') {
    return (
      <View style={styles.card}>
        <View style={styles.failedBox}>
          <Text style={styles.failedHeading}>Payment not completed</Text>
          <Text style={styles.failedNote}>{failedMessage}</Text>
        </View>
        <TouchableOpacity
          style={styles.retryBtn}
          onPress={retryKeepInputs}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Try again"
        >
          <Text style={styles.donateBtnText}>Try Again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Unconfirmed (poll bound expired while PENDING — the honest unknown) ─────────
  if (donationState === 'unconfirmed') {
    return (
      <View style={styles.card}>
        <View style={styles.unconfirmedBox}>
          <Text style={styles.unconfirmedHeading}>Still confirming…</Text>
          <Text style={styles.unconfirmedNote}>
            We haven&apos;t confirmed your payment yet. If money left your M-Pesa, your
            donation is safe and you&apos;ll receive an SMS confirmation shortly. If not,
            you can try again.
          </Text>
        </View>
        <TouchableOpacity
          style={styles.againBtn}
          onPress={reset}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Start over"
        >
          <Text style={styles.againBtnText}>Start Over</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Idle / Submitting ────────────────────────────────────────────────────────
  const busy = donationState === 'submitting';
  return (
    <View style={styles.card}>
      <Text style={styles.formTitle}>Donate via M-Pesa</Text>

      <View style={styles.inputGroup}>
        <Text style={styles.label}>M-Pesa Phone Number</Text>
        <TextInput
          style={[styles.input, errors.phone ? styles.inputError : null]}
          placeholder="e.g. 0712 345 678"
          placeholderTextColor={Colors.textMuted}
          keyboardType="phone-pad"
          value={phone}
          onChangeText={v => { setPhone(v); clearError('phone'); }}
          maxLength={13}
          returnKeyType="next"
          editable={!busy}
          accessibilityLabel="M-Pesa phone number"
        />
        {errors.phone ? <Text style={styles.errorText}>{errors.phone}</Text> : null}
      </View>

      <View style={styles.inputGroup}>
        <Text style={styles.label}>Amount (KES)</Text>
        <TextInput
          style={[styles.input, errors.amount ? styles.inputError : null]}
          placeholder="Minimum KES 5"
          placeholderTextColor={Colors.textMuted}
          keyboardType="numeric"
          value={amount}
          onChangeText={v => { setAmount(v); clearError('amount'); }}
          returnKeyType="next"
          editable={!busy}
          accessibilityLabel="Donation amount in Kenyan shillings"
        />
        {errors.amount ? <Text style={styles.errorText}>{errors.amount}</Text> : null}
      </View>

      <View style={styles.inputGroup}>
        <Text style={styles.label}>Your name (optional)</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. John Kamau"
          placeholderTextColor={Colors.textMuted}
          autoCapitalize="words"
          value={donorName}
          onChangeText={setDonorName}
          returnKeyType="next"
          editable={!busy}
          accessibilityLabel="Your name, optional"
        />
      </View>

      <View style={styles.inputGroup}>
        <Text style={styles.label}>Email (optional)</Text>
        <TextInput
          style={styles.input}
          placeholder="For campaign updates"
          placeholderTextColor={Colors.textMuted}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          value={email}
          onChangeText={setEmail}
          returnKeyType="done"
          editable={!busy}
          accessibilityLabel="Email address, optional"
        />
      </View>

      <TouchableOpacity
        style={[styles.donateBtn, busy && styles.donateBtnBusy]}
        onPress={handleDonate}
        disabled={busy}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Donate now via M-Pesa"
        accessibilityState={{ busy, disabled: busy }}
      >
        {busy
          ? <ActivityIndicator color={Colors.white} size="small" />
          : <Text style={styles.donateBtnText}>Donate Now</Text>
        }
      </TouchableOpacity>

      <Text style={styles.finePrint}>
        You will receive an M-Pesa prompt on your phone. Enter your PIN to complete.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.white,
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.md,
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  formTitle: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.primary,
    marginBottom: Spacing.md,
  },
  inputGroup: {
    marginBottom: Spacing.md,
  },
  label: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.text,
    marginBottom: 6,
  },
  input: {
    height: Spacing.touch,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.text,
    backgroundColor: Colors.white,
  },
  inputError: {
    borderColor: Colors.danger,
  },
  errorText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.danger,
    marginTop: 4,
  },
  donateBtn: {
    backgroundColor: Colors.accent,
    borderRadius: BorderRadius.md,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.xs,
    marginBottom: Spacing.sm,
  },
  donateBtnBusy: {
    opacity: 0.6,
  },
  donateBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.white,
  },
  finePrint: {
    fontFamily: 'Poppins-Regular',
    fontSize: 11,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 16,
  },

  // Confirming state
  confirmingBox: {
    alignItems: 'center',
    paddingVertical: Spacing.lg,
  },
  confirmingHeading: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.primary,
    marginTop: Spacing.md,
    marginBottom: 6,
  },
  confirmingNote: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: FontSize.sm * 1.5,
    paddingHorizontal: Spacing.sm,
  },

  // Success state
  successBox: {
    backgroundColor: Colors.successLight,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    alignItems: 'center',
  },
  resultHeading: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.success,
    marginBottom: 4,
  },
  receiptText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.success,
    marginBottom: 6,
  },
  resultNote: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.success,
    textAlign: 'center',
  },
  againBtn: {
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.md,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  againBtnText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.primary,
  },

  // Failed state
  failedBox: {
    backgroundColor: Colors.dangerLight,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    alignItems: 'center',
  },
  failedHeading: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.danger,
    marginBottom: 4,
  },
  failedNote: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.danger,
    textAlign: 'center',
    lineHeight: FontSize.sm * 1.5,
  },
  retryBtn: {
    backgroundColor: Colors.accent,
    borderRadius: BorderRadius.md,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Unconfirmed state
  unconfirmedBox: {
    backgroundColor: Colors.warningLight,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    alignItems: 'center',
  },
  unconfirmedHeading: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.warning,
    marginBottom: 4,
  },
  unconfirmedNote: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.warning,
    textAlign: 'center',
    lineHeight: FontSize.sm * 1.5,
  },
});
