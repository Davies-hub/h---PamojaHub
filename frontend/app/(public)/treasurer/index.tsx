import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import OTPInput, { OTPInputRef } from '../../../components/ui/OTPInput';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BorderRadius, Colors, FontSize, Spacing } from '../../../constants/theme';
import { mockTreasurerProfile } from '../../../mock/treasurer.mock';
import { treasurerPortalService } from '../../../services/treasurer-portal.service';
import type { PortalDonationRow } from '../../../services/mappers';
import { PortalCampaign } from '../../../types';

// ─── Types and helpers ────────────────────────────────────────────────────────

type PortalState = 'phone' | 'otp' | 'dashboard';

interface PendingDisbursement {
  id: string;
  campaignId: string;
  amount: number;
  requestedAt: string;
}

function fmtKes(n: number) {
  return `KES ${n.toLocaleString('en-KE')}`;
}

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function maskPhone(p: string): string {
  const d = p.replace(/\s/g, '');
  if (d.length < 7) return d;
  return `${d.slice(0, 4)} *** ${d.slice(-3)}`;
}

// ── Error mapping (HTTP status → user-facing message) ───────────────────────────
// request-otp / verify-otp are PUBLIC (no token) and never 401. A missing response
// (no `.response`) = network/timeout → the generic retry message.
function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | undefined)?.response?.status;
}

function mapRequestOtpError(err: unknown): string {
  switch (httpStatus(err)) {
    case 429: return 'Too many attempts. Please wait a few minutes and try again.';
    case 502: return "Couldn't send the code right now. Please try again.";
    default:  return 'Something went wrong. Please check your connection and try again.';
  }
}

function mapVerifyOtpError(err: unknown): string {
  switch (httpStatus(err)) {
    // 400 = GENERIC_INVALID: a wrong code AND an expired code both land here. The backend
    // deliberately does not distinguish, so neither do we.
    case 400: return 'Invalid or expired code.';
    case 429: return 'Too many attempts. Request a new code shortly.';
    default:  return 'Something went wrong. Please check your connection and try again.';
  }
}

// request-disbursement 400 comes in TWO shapes (both confirmed against the backend):
//   * {"detail": "..."}            — business guards: closed campaign / blocking payout /
//                                    amount over wallet (and the 404 "Campaign not found").
//   * {"amount":[...]}/{"reason":[...]} — DRF serializer field-errors.
// callPortal already swallows 401/403 → re-auth, so anything reaching the modal's catch is
// a 400 (or a bodyless network/timeout error). This parses whichever shape arrived; the
// caller routes detail → general surface, amount/reason → the matching field.
interface ParsedDisbursementError {
  detail?: string;
  amount?: string;
  reason?: string;
}

function firstErrString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

function parseDisbursementError(err: unknown): ParsedDisbursementError {
  const body = (err as { response?: { data?: unknown } } | undefined)?.response?.data;
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  return {
    detail: firstErrString(b.detail),
    amount: firstErrString(b.amount),
    reason: firstErrString(b.reason),
  };
}

// ─── Wordmark ─────────────────────────────────────────────────────────────────

function Wordmark() {
  return (
    <Text style={styles.wordmark}>
      <Text style={styles.wordmarkPamoja}>Pamoja</Text>
      <Text style={styles.wordmarkHub}>Hub</Text>
    </Text>
  );
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export default function TreasurerPortalScreen() {
  const router = useRouter();
  const [portalState, setPortalState] = useState<PortalState>('phone');

  // Phone state
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [isSendingOtp, setIsSendingOtp] = useState(false);
  // Set by the portal auth-loss chokepoint — shown on the phone screen on re-entry.
  const [authLostMessage, setAuthLostMessage] = useState('');

  // OTP state
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [otpError, setOtpError] = useState('');
  const [countdown, setCountdown] = useState(60);
  const [isVerifying, setIsVerifying] = useState(false);
  const otpInputRef = useRef<OTPInputRef>(null);

  // Portal session — held in MEMORY ONLY (never persisted to storage.ts / secure-store).
  const [portalToken, setPortalToken] = useState<string | null>(null);
  const [portalCampaigns, setPortalCampaigns] = useState<PortalCampaign[]>([]);

  // Dashboard state
  const [selectedCampaign, setSelectedCampaign] = useState<PortalCampaign | null>(null);
  const [portalDonations, setPortalDonations] = useState<PortalDonationRow[]>([]);
  const [donationsLoading, setDonationsLoading] = useState(false);
  const [donationsError, setDonationsError] = useState('');
  const [pendingDisbursements, setPendingDisbursements] = useState<PendingDisbursement[]>([]);

  // Request Payout modal
  const [showPayoutModal, setShowPayoutModal] = useState(false);
  const [payoutAmount, setPayoutAmount] = useState('');
  const [payoutAmountError, setPayoutAmountError] = useState('');
  const [payoutReason, setPayoutReason] = useState('');
  const [payoutReasonError, setPayoutReasonError] = useState('');   // reason now backend-required
  const [payoutSubmitError, setPayoutSubmitError] = useState('');   // general (backend detail) surface
  const [payoutSubmitting, setPayoutSubmitting] = useState(false);  // in-flight → disable submit
  const [kbOffset, setKbOffset] = useState(0);

  useEffect(() => {
    if (!showPayoutModal) { setKbOffset(0); return; }
    const show = Keyboard.addListener('keyboardDidShow', e => setKbOffset(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbOffset(0));
    return () => { show.remove(); hide.remove(); };
  }, [showPayoutModal]);

  // Countdown timer — resets each time OTP view is entered
  useEffect(() => {
    if (portalState !== 'otp') return;
    setCountdown(60);
    const t = setInterval(() => setCountdown(c => (c > 0 ? c - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [portalState]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleSendOtp() {
    const d = phone.replace(/\s/g, '');
    if (!d) { setPhoneError('Phone number is required'); return; }
    if (!/^(07|01)\d{8}$/.test(d)) {
      setPhoneError('Enter a valid Kenyan number (07xx or 01xx)');
      return;
    }
    setPhoneError('');
    setAuthLostMessage('');
    setIsSendingOtp(true);
    try {
      // Uniform 200 for known AND unknown phones — we ALWAYS advance to OTP entry. We
      // neither learn nor reveal whether a code was actually sent (anti-enumeration).
      await treasurerPortalService.requestOtp(d);
      setOtp(['', '', '', '', '', '']);
      setOtpError('');
      setPortalState('otp');
      setTimeout(() => otpInputRef.current?.focus(), 300);
    } catch (err) {
      setPhoneError(mapRequestOtpError(err));
    } finally {
      setIsSendingOtp(false);
    }
  }

  async function handleVerifyOtp(code: string) {
    const d = phone.replace(/\s/g, '');
    setIsVerifying(true);
    setOtpError('');
    try {
      const { portalToken: token, campaigns } = await treasurerPortalService.verifyOtp(d, code);
      setPortalToken(token);            // held in memory only
      setPortalCampaigns(campaigns);
      setPortalState('dashboard');
    } catch (err) {
      setOtpError(mapVerifyOtpError(err));
      setOtp(['', '', '', '', '', '']);   // clear boxes so the user can retype
      setTimeout(() => otpInputRef.current?.focus(), 100);
    } finally {
      setIsVerifying(false);
    }
  }

  async function handleResend() {
    const d = phone.replace(/\s/g, '');
    setOtp(['', '', '', '', '', '']);
    setOtpError('');
    setCountdown(60);
    try {
      await treasurerPortalService.requestOtp(d);
    } catch (err) {
      setOtpError(mapRequestOtpError(err));
    }
    setTimeout(() => otpInputRef.current?.focus(), 100);
  }

  // ── Portal auth-loss chokepoint (Option A) ───────────────────────────────────
  // A portal-TOKEN call (X-Portal-Token) failing with 401 (dead/expired/revoked/wrong-IP
  // token — the load-bearing case) or 403 (campaign out of scope) means the portal session
  // is over. Reset to phone re-entry (a NEW OTP must be requested) and tell the user.
  // Mirrors handleSignOut's reset.
  function handlePortalAuthLost() {
    setPortalToken(null);
    setPortalCampaigns([]);
    setSelectedCampaign(null);
    setPortalDonations([]);
    setDonationsError('');
    setOtp(['', '', '', '', '', '']);
    setOtpError('');
    setPhoneError('');
    setAuthLostMessage('Your session expired. Please verify your number again.');
    setPortalState('phone');
  }

  // SHARED wrapper for EVERY portal-token call (getCampaignReport now; requestDisbursement
  // next slice). Routes 401/403 through the single chokepoint so the re-auth path is
  // inherited, never re-implemented per call. Non-auth errors propagate to the caller.
  async function callPortal<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      const s = httpStatus(err);
      if (s === 401 || s === 403) {
        handlePortalAuthLost();
        return undefined;
      }
      throw err;
    }
  }

  // Selecting a campaign loads its REAL donation feed via a portal-token call — the
  // vehicle that exercises the chokepoint. callPortal routes a dead-token 401/403 to
  // re-auth; a network/5xx error shows an inline load error.
  async function handleSelectCampaign(campaign: PortalCampaign) {
    setSelectedCampaign(campaign);
    setPortalDonations([]);
    setDonationsError('');
    if (!portalToken) return;
    setDonationsLoading(true);
    try {
      const rows = await callPortal(() =>
        treasurerPortalService.getCampaignReport(campaign.id, portalToken),
      );
      if (rows) setPortalDonations(rows);
    } catch {
      setDonationsError('Could not load donations. Tap the campaign again to retry.');
    } finally {
      setDonationsLoading(false);
    }
  }

  function handleRequestDisbursement() {
    if (!selectedCampaign) return;
    setPayoutAmount(String(selectedCampaign.walletBalance));
    setPayoutAmountError('');
    setPayoutReason('');
    setPayoutReasonError('');
    setPayoutSubmitError('');
    setShowPayoutModal(true);
  }

  function handlePayoutClose() {
    setShowPayoutModal(false);
    setPayoutAmount('');
    setPayoutReason('');
    setPayoutAmountError('');
    setPayoutReasonError('');
    setPayoutSubmitError('');
  }

  // REAL money-write (replaces the former mock append). Client-side fast-fail FIRST (amount
  // > 0, amount ≤ wallet, reason non-empty) so the obvious cases never hit the network. Then
  // POST through callPortal: a dead-token 401 / out-of-scope 403 is swallowed → re-auth
  // (row === undefined); every business rejection is a 400 and re-throws to the catch, where
  // we map both 400 shapes. On 201 we append the REAL returned row (no wallet refetch — a
  // PENDING_APPROVAL request moves no money).
  async function handlePayoutSubmit() {
    if (!selectedCampaign || !portalToken) return;

    const parsed = Number(payoutAmount.replace(/,/g, ''));
    if (!payoutAmount.trim() || isNaN(parsed) || parsed <= 0) {
      setPayoutAmountError('Enter a valid amount greater than 0');
      return;
    }
    if (parsed > selectedCampaign.walletBalance) {
      setPayoutAmountError(`Cannot exceed available balance of ${fmtKes(selectedCampaign.walletBalance)}`);
      return;
    }
    if (!payoutReason.trim()) {
      setPayoutReasonError('A reason is required');
      return;
    }

    setPayoutSubmitting(true);
    setPayoutSubmitError('');
    try {
      const row = await callPortal(() =>
        treasurerPortalService.requestDisbursement(
          selectedCampaign.id,
          portalToken,
          { amount: parsed, reason: payoutReason.trim() },
        ),
      );

      // undefined === auth lost: callPortal already reset to 'phone'. Close the now-orphaned
      // modal so it doesn't reappear on re-auth; show NO success and NO generic error.
      if (!row) {
        handlePayoutClose();
        return;
      }

      // 201 — append the REAL row (its id + createdAt + amount). campaignId is not on the
      // WithdrawalSerializer wire, so it comes from the selected-campaign context.
      setPendingDisbursements(prev => [
        {
          id: row.id,
          campaignId: selectedCampaign.id,
          amount: row.amount,
          requestedAt: row.createdAt,
        },
        ...prev,
      ]);
      handlePayoutClose();
    } catch (err) {
      // Re-thrown 400 (callPortal only swallows 401/403). Map BOTH shapes; keep the modal
      // OPEN with inputs intact so the user can correct.
      const parsedErr = parseDisbursementError(err);
      if (parsedErr.amount) setPayoutAmountError(parsedErr.amount);
      if (parsedErr.reason) setPayoutReasonError(parsedErr.reason);
      if (parsedErr.detail) {
        setPayoutSubmitError(parsedErr.detail);
      } else if (!parsedErr.amount && !parsedErr.reason) {
        // No recognizable body (network / timeout / unknown).
        setPayoutSubmitError('Something went wrong. Please try again.');
      }
    } finally {
      setPayoutSubmitting(false);
    }
  }

  function handleSignOut() {
    setPortalState('phone');
    setPhone('');
    setOtp(['', '', '', '', '', '']);
    setOtpError('');
    setPhoneError('');
    setAuthLostMessage('');
    setSelectedCampaign(null);
    setPortalToken(null);
    setPortalCampaigns([]);
    setPortalDonations([]);
  }

  // ── Render: Phone entry ───────────────────────────────────────────────────

  if (portalState === 'phone') {
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.root}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <ScrollView
            contentContainerStyle={styles.centeredContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <TouchableOpacity
              style={styles.homeLink}
              onPress={() => router.push('/')}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Back to home"
            >
              <Ionicons name="arrow-back" size={16} color={Colors.textMuted} />
              <Text style={styles.homeLinkText}>Home</Text>
            </TouchableOpacity>

            <Wordmark />

            <View style={styles.lockCircle}>
              <Ionicons name="lock-closed-outline" size={32} color={Colors.primary} />
            </View>

            <Text style={styles.stateHeading}>Treasurer Portal</Text>
            <Text style={styles.stateSubtext}>
              Access your campaign reports and request payouts
            </Text>

            {authLostMessage ? (
              <View style={styles.noticeBanner}>
                <Ionicons name="alert-circle-outline" size={18} color={Colors.warning} />
                <Text style={styles.noticeText}>{authLostMessage}</Text>
              </View>
            ) : null}

            <View style={styles.inputGroup}>
              <Text style={styles.label}>M-Pesa Phone Number</Text>
              <TextInput
                style={[styles.input, phoneError ? styles.inputError : null]}
                placeholder="e.g. 0712 345 678"
                placeholderTextColor={Colors.textMuted}
                keyboardType="phone-pad"
                value={phone}
                onChangeText={v => { setPhone(v); setPhoneError(''); }}
                maxLength={13}
                returnKeyType="done"
                accessibilityLabel="M-Pesa phone number registered with your church"
              />
              {phoneError ? <Text style={styles.errorText}>{phoneError}</Text> : null}
            </View>

            <TouchableOpacity
              style={[styles.primaryBtn, isSendingOtp && styles.primaryBtnDisabled]}
              onPress={handleSendOtp}
              disabled={isSendingOtp}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Send OTP"
            >
              <Text style={styles.primaryBtnText}>{isSendingOtp ? 'Sending…' : 'Send OTP'}</Text>
            </TouchableOpacity>

            <Text style={styles.finePrint}>
              Enter the M-Pesa number registered with your church treasurer account.
              {'\n'}You will receive a 6-digit code via SMS.
            </Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // ── Render: OTP entry ─────────────────────────────────────────────────────

  if (portalState === 'otp') {
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.root}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <ScrollView
            contentContainerStyle={styles.centeredContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <TouchableOpacity
              style={styles.homeLink}
              onPress={() => router.push('/')}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Back to home"
            >
              <Ionicons name="arrow-back" size={16} color={Colors.textMuted} />
              <Text style={styles.homeLinkText}>Home</Text>
            </TouchableOpacity>

            <Wordmark />

            <View style={styles.lockCircle}>
              <Ionicons name="chatbubble-ellipses-outline" size={32} color={Colors.primary} />
            </View>

            <Text style={styles.stateHeading}>Enter Verification Code</Text>
            <Text style={styles.stateSubtext}>
              We sent a 6-digit code to{'\n'}
              <Text style={styles.phoneMasked}>{maskPhone(phone)}</Text>
            </Text>

            {/* 6 OTP boxes — auto-submits on 6th digit */}
            <View style={styles.otpRow}>
              <OTPInput
                ref={otpInputRef}
                value={otp}
                onChange={setOtp}
                onComplete={handleVerifyOtp}
                disabled={isVerifying}
              />
            </View>

            {isVerifying ? (
              <Text style={styles.verifyingText}>Verifying…</Text>
            ) : otpError ? (
              <Text style={styles.otpError}>{otpError}</Text>
            ) : null}

            <View style={styles.resendRow}>
              {countdown > 0 ? (
                <Text style={styles.resendCountdown}>Resend code in {countdown}s</Text>
              ) : (
                <TouchableOpacity
                  onPress={handleResend}
                  accessibilityRole="button"
                  accessibilityLabel="Resend OTP"
                >
                  <Text style={styles.resendLink}>Resend OTP</Text>
                </TouchableOpacity>
              )}
            </View>

            <TouchableOpacity
              style={styles.wrongNumberBtn}
              onPress={() => setPortalState('phone')}
              accessibilityRole="button"
              accessibilityLabel="Change phone number"
            >
              <Text style={styles.wrongNumberText}>Wrong number? Change it</Text>
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // ── Render: Dashboard ─────────────────────────────────────────────────────

  const campaignDisbursements = selectedCampaign
    ? pendingDisbursements.filter(d => d.campaignId === selectedCampaign.id)
    : [];
  // Real church name from the verify-otp response (all of a treasurer's scoped campaigns
  // share one church). goal_amount is NOT on the portal wire, so no progress-to-goal.
  const churchName = portalCampaigns[0]?.churchName ?? '';

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: Colors.primary }}>
    <SafeAreaView edges={['bottom']} style={styles.root}>
      {/* Dashboard header bar */}
      <View style={styles.dashHeader}>
        {selectedCampaign ? (
          <TouchableOpacity
            style={styles.dashBackBtn}
            onPress={() => setSelectedCampaign(null)}
            accessibilityRole="button"
            accessibilityLabel="Back to campaign list"
          >
            <Ionicons name="arrow-back" size={20} color={Colors.white} />
          </TouchableOpacity>
        ) : (
          <View style={styles.dashBackBtn} />
        )}
        <View style={styles.dashHeaderCenter}>
          <Text style={styles.dashHeaderTitle} numberOfLines={1}>
            {selectedCampaign ? selectedCampaign.title : 'Treasurer Portal'}
          </Text>
          <Text style={styles.dashHeaderSub} numberOfLines={1}>
            {churchName}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.dashBackBtn}
          onPress={handleSignOut}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
        >
          <Ionicons name="log-out-outline" size={20} color={Colors.white} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.dashContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Campaign picker ── */}
        {!selectedCampaign && (
          <>
            <View style={styles.greetingSection}>
              <Text style={styles.greetingText}>
                {getGreeting()}, {mockTreasurerProfile.firstName}
              </Text>
              <Text style={styles.greetingSub}>Select a campaign to view its report</Text>
            </View>

            {portalCampaigns.length === 0 ? (
              <Text style={styles.noDataText}>No campaigns are linked to this number.</Text>
            ) : (
              portalCampaigns.map(campaign => (
                <TouchableOpacity
                  key={campaign.id}
                  style={styles.campaignPickerCard}
                  onPress={() => handleSelectCampaign(campaign)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`View ${campaign.title}`}
                >
                  <View style={styles.pickerCardBody}>
                    <Text style={styles.pickerTitle}>{campaign.title}</Text>
                    <Text style={styles.pickerAmount}>
                      {fmtKes(campaign.walletBalance)}{' '}
                      <Text style={styles.pickerGoal}>available to pay out</Text>
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={Colors.textMuted} />
                </TouchableOpacity>
              ))
            )}
          </>
        )}

        {/* ── Campaign scoped view ── */}
        {selectedCampaign && (
          <>
            {/* Progress summary — raised + wallet are REAL. goal_amount is not on the
                portal wire (PortalCampaignSerializer omits it), so no progress-to-goal bar. */}
            <View style={styles.progressCard}>
              <Text style={styles.progressRaised}>{fmtKes(selectedCampaign.raisedAmount)} raised</Text>
              <Text style={styles.progressDisburse}>{fmtKes(selectedCampaign.walletBalance)} to disburse</Text>
            </View>

            {/* Request Payout */}
            <TouchableOpacity
              style={[
                styles.disbursementBtn,
                selectedCampaign.walletBalance === 0 && styles.disbursementBtnDisabled,
              ]}
              onPress={handleRequestDisbursement}
              disabled={selectedCampaign.walletBalance === 0}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Request payout"
            >
              <Ionicons name="arrow-up-circle-outline" size={20} color={Colors.white} />
              <Text style={styles.disbursementBtnText}>Request Payout</Text>
            </TouchableOpacity>

            {/* Pending requests */}
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Pending Requests</Text>
              {campaignDisbursements.length === 0 ? (
                <Text style={styles.noDataText}>No pending payout requests</Text>
              ) : (
                campaignDisbursements.map(req => (
                  <View key={req.id} style={styles.disbRow}>
                    <View style={styles.disbRowLeft}>
                      <Text style={styles.disbId}>{req.id}</Text>
                      <Text style={styles.disbTime}>{timeAgo(req.requestedAt)}</Text>
                    </View>
                    <View style={styles.disbRight}>
                      <Text style={styles.disbAmount}>{fmtKes(req.amount)}</Text>
                      <View style={styles.pendingBadge}>
                        <Text style={styles.pendingBadgeText}>Pending</Text>
                      </View>
                    </View>
                  </View>
                ))
              )}
            </View>

            {/* Recent donations — REAL, via the portal-token report call (NET amounts). */}
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Recent Donations</Text>
              {donationsLoading ? (
                <Text style={styles.noDataText}>Loading donations…</Text>
              ) : donationsError ? (
                <Text style={styles.donationsError}>{donationsError}</Text>
              ) : portalDonations.length === 0 ? (
                <Text style={styles.noDataText}>No donations recorded yet</Text>
              ) : (
                portalDonations.map((don, i) => (
                  <View
                    // Receipt + index: the report serializer exposes no donation id, and
                    // receipts CAN repeat in dev data (sandbox reuse), so receipt alone is
                    // not a safe key. The list is fetched fresh per select and never reordered.
                    key={`${don.mpesaReceipt}-${i}`}
                    style={[
                      styles.donRow,
                      i < portalDonations.length - 1 && styles.donRowBorder,
                    ]}
                  >
                    <View style={styles.donLeft}>
                      <Text style={styles.donName}>
                        {don.donorName ?? 'Anonymous'}
                      </Text>
                      <Text style={styles.donReceipt}>{don.mpesaReceipt}</Text>
                    </View>
                    <View style={styles.donRight}>
                      <Text style={styles.donAmount}>{fmtKes(don.netAmount)}</Text>{/* Net per Net-Everywhere rule */}
                      <Text style={styles.donTime}>{timeAgo(don.createdAt)}</Text>
                    </View>
                  </View>
                ))
              )}
            </View>
          </>
        )}
      </ScrollView>

      {/* ── Request Payout Modal ── */}
      <Modal
        visible={showPayoutModal}
        transparent
        animationType="slide"
        onRequestClose={handlePayoutClose}
      >
        <View style={styles.modalKavContainer}>
          <TouchableOpacity
            style={styles.modalOverlay}
            onPress={handlePayoutClose}
            activeOpacity={1}
          />
          <View style={[styles.payoutSheet, kbOffset > 0 ? { marginBottom: kbOffset } : null]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Request Payout</Text>
            {selectedCampaign ? (
              <Text style={styles.sheetMeta} numberOfLines={1}>{selectedCampaign.title}</Text>
            ) : null}
            <View style={styles.sheetDivider} />

            <Text style={styles.sheetFieldLabel}>
              Amount (KES) <Text style={styles.required}>*</Text>
            </Text>
            <TextInput
              style={[styles.sheetInput, payoutAmountError ? styles.sheetInputError : null]}
              value={payoutAmount}
              onChangeText={v => { setPayoutAmount(v); if (payoutAmountError) setPayoutAmountError(''); }}
              keyboardType="numeric"
              placeholder="Enter amount"
              placeholderTextColor={Colors.textMuted}
              returnKeyType="done"
              accessibilityLabel="Payout amount"
            />
            {payoutAmountError ? (
              <Text style={styles.sheetError}>{payoutAmountError}</Text>
            ) : selectedCampaign ? (
              <Text style={styles.sheetHint}>Available: {fmtKes(selectedCampaign.walletBalance)}</Text>
            ) : null}

            <Text style={[styles.sheetFieldLabel, { marginTop: Spacing.md }]}>
              Reason <Text style={styles.required}>*</Text>
            </Text>
            <TextInput
              style={[styles.sheetInput, payoutReasonError ? styles.sheetInputError : null]}
              value={payoutReason}
              onChangeText={v => { setPayoutReason(v); if (payoutReasonError) setPayoutReasonError(''); }}
              placeholder="e.g. Purchase of building materials"
              placeholderTextColor={Colors.textMuted}
              returnKeyType="done"
              accessibilityLabel="Reason for payout"
            />
            {payoutReasonError ? (
              <Text style={styles.sheetError}>{payoutReasonError}</Text>
            ) : null}

            {/* General (backend detail) surface — closed / blocking / over-cap / network.
                Distinct from the per-field amount & reason errors above. */}
            {payoutSubmitError ? (
              <View style={styles.sheetSubmitError}>
                <Ionicons name="alert-circle-outline" size={16} color={Colors.danger} />
                <Text style={styles.sheetSubmitErrorText}>{payoutSubmitError}</Text>
              </View>
            ) : null}

            <View style={styles.sheetActions}>
              <TouchableOpacity
                style={styles.sheetCancelBtn}
                onPress={handlePayoutClose}
                disabled={payoutSubmitting}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Cancel payout request"
              >
                <Text style={styles.sheetCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.sheetConfirmBtn, payoutSubmitting && styles.sheetConfirmBtnDisabled]}
                onPress={handlePayoutSubmit}
                disabled={payoutSubmitting}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Submit payout request"
              >
                {payoutSubmitting ? (
                  <ActivityIndicator size="small" color={Colors.white} />
                ) : (
                  <>
                    <Ionicons name="arrow-up-circle-outline" size={18} color={Colors.white} />
                    <Text style={styles.sheetConfirmText}>Request Payout</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

    </SafeAreaView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  flex: { flex: 1 },

  // Centered phone/otp layout
  centeredContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.xl,
  },
  wordmark: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxxl,
    marginBottom: Spacing.md,
  },
  wordmarkPamoja: {
    color: Colors.primary,
  },
  wordmarkHub: {
    color: Colors.accent,
  },
  lockCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  stateHeading: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxl,
    color: Colors.text,
    textAlign: 'center',
    marginBottom: 8,
  },
  stateSubtext: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: FontSize.md * 1.6,
    marginBottom: Spacing.xl,
  },
  phoneMasked: {
    fontFamily: 'Poppins-SemiBold',
    color: Colors.text,
  },

  // Inputs
  inputGroup: {
    width: '100%',
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
    fontSize: FontSize.lg,
    color: Colors.text,
    backgroundColor: Colors.white,
    width: '100%',
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

  // Primary button
  primaryBtn: {
    backgroundColor: Colors.accent,
    borderRadius: BorderRadius.md,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    marginTop: Spacing.xs,
    marginBottom: Spacing.md,
  },
  primaryBtnDisabled: {
    opacity: 0.5,
  },
  primaryBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.white,
  },
  finePrint: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 18,
  },
  homeLink: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    paddingVertical: Spacing.xs,
    marginBottom: Spacing.md,
  },
  homeLinkText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },

  // Auth-loss notice (phone screen, on portal re-entry)
  noticeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    backgroundColor: Colors.warningLight,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    marginBottom: Spacing.md,
  },
  noticeText: {
    flex: 1,
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.warning,
  },

  // OTP screen status / error
  otpError: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.danger,
    textAlign: 'center',
    marginBottom: Spacing.sm,
  },
  verifyingText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    textAlign: 'center',
    marginBottom: Spacing.sm,
  },
  donationsError: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.danger,
    textAlign: 'center',
    paddingVertical: Spacing.sm,
  },

  // OTP boxes
  otpRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.xl,
  },
  otpBox: {
    width: 48,
    height: 58,
    borderWidth: 2,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxl,
    color: Colors.text,
    backgroundColor: Colors.white,
    textAlign: 'center',
  },
  otpBoxFilled: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryLight,
    color: Colors.primary,
  },
  otpBoxFocused: {
    borderColor: Colors.primary,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 2,
  },

  // Resend + wrong number
  resendRow: {
    marginBottom: Spacing.sm,
  },
  resendCountdown: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  resendLink: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.accent,
    textAlign: 'center',
  },
  wrongNumberBtn: {
    paddingVertical: Spacing.sm,
  },
  wrongNumberText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.primary,
    textAlign: 'center',
    textDecorationLine: 'underline',
  },

  // Dashboard header
  dashHeader: {
    backgroundColor: Colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
  },
  dashBackBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dashHeaderCenter: {
    flex: 1,
    alignItems: 'center',
  },
  dashHeaderTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.white,
  },
  dashHeaderSub: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: 'rgba(255,255,255,0.75)',
  },

  // Dashboard content
  dashContent: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xl,
    gap: Spacing.md,
  },

  // Greeting
  greetingSection: {
    paddingBottom: Spacing.xs,
  },
  greetingText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxl,
    color: Colors.text,
  },
  greetingSub: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    marginTop: 2,
  },

  // Campaign picker cards
  campaignPickerCard: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
    gap: Spacing.sm,
  },
  pickerCardBody: {
    flex: 1,
    gap: 6,
  },
  pickerGroup: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.primary,
  },
  pickerTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.text,
  },
  pickerAmount: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.sm,
    color: Colors.primary,
    marginTop: 2,
  },
  pickerGoal: {
    fontFamily: 'Poppins-Regular',
    color: Colors.textMuted,
  },

  // Campaign scoped view
  progressCard: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    gap: 8,
  },
  groupLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.primary,
  },
  progressMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: 4,
  },
  progressRaised: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.primary,
  },
  progressDisburse: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.accent,
  },
  progressPercent: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.accent,
  },
  progressGoal: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },

  // Stats
  statsRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  statBox: {
    flex: 1,
    backgroundColor: Colors.grey,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    alignItems: 'center',
  },
  statBoxLeft: {},
  statBoxRight: {},
  statValue: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.text,
    textAlign: 'center',
  },
  statLabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 2,
    textAlign: 'center',
  },
  walletBox: {
    backgroundColor: Colors.grey,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    alignItems: 'center',
  },

  // Disbursement button
  disbursementBtn: {
    backgroundColor: Colors.accent,
    borderRadius: BorderRadius.md,
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  disbursementBtnDisabled: {
    opacity: 0.4,
  },
  disbursementBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.white,
  },

  // Section cards (pending + donations)
  sectionCard: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  sectionTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.text,
  },
  noDataText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    textAlign: 'center',
    paddingVertical: Spacing.sm,
  },

  // Disbursement rows
  disbRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: Spacing.xs,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  disbRowLeft: {
    gap: 2,
  },
  disbId: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  disbTime: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  disbRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  disbAmount: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.text,
  },
  pendingBadge: {
    backgroundColor: Colors.warningLight,
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  pendingBadgeText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.warning,
  },

  // Donation rows
  donRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: Spacing.sm,
  },
  donRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  donLeft: {
    flex: 1,
    marginRight: Spacing.sm,
  },
  donName: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  donReceipt: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 2,
  },
  donRight: {
    alignItems: 'flex-end',
  },
  donAmount: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },
  donTime: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 2,
  },

  // Request Payout modal
  modalKavContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  payoutSheet: {
    backgroundColor: Colors.white,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    padding: Spacing.md,
    paddingBottom: Spacing.xxl,
    gap: Spacing.sm,
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: 'center',
    marginBottom: Spacing.sm,
  },
  sheetTitle: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.text,
  },
  sheetMeta: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  sheetDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: Spacing.xs,
  },
  sheetFieldLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: 4,
  },
  required: {
    color: Colors.danger,
  },
  sheetInput: {
    height: 48,
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.text,
    backgroundColor: Colors.white,
  },
  sheetInputError: {
    borderColor: Colors.danger,
  },
  sheetError: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.danger,
    marginTop: 2,
  },
  sheetHint: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 2,
  },
  sheetActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  sheetCancelBtn: {
    flex: 1,
    height: 50,
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetCancelText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
  },
  sheetConfirmBtn: {
    flex: 2,
    height: 50,
    backgroundColor: Colors.accent,
    borderRadius: BorderRadius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  sheetConfirmBtnDisabled: {
    opacity: 0.6,
  },
  sheetConfirmText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.white,
  },

  // General submit-error surface (backend {"detail":...})
  sheetSubmitError: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: Colors.dangerLight,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
    marginTop: Spacing.xs,
  },
  sheetSubmitErrorText: {
    flex: 1,
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.danger,
  },
});
