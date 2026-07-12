import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Screen, { useIsWideWeb } from '../../components/layout/Screen';
import OTPInput, { OTPInputRef } from '../../components/ui/OTPInput';
import { BorderRadius, Colors, FontSize, Shadows, Spacing } from '../../constants/theme';
import { authService } from '../../services/auth.service';

type ResetState = 'email' | 'otp' | 'success';

function Wordmark() {
  return (
    <Text style={styles.wordmark}>
      <Text style={styles.wordmarkPamoja}>Pamoja</Text>
      <Text style={styles.wordmarkHub}>Hub</Text>
    </Text>
  );
}

export default function ResetPasswordScreen() {
  const router = useRouter();
  const isWideWeb = useIsWideWeb();

  const [state, setState] = useState<ResetState>('email');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  // OTP/general error on the reset step — surfaces the collapsed 400 {detail}
  // ('Invalid or expired code.') and network failures, kept SEPARATE from the
  // password-field error so a server password-policy 400 lands under the field.
  const [resetError, setResetError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const otpInputRef = useRef<OTPInputRef>(null);

  async function handleSendOtp() {
    const trimmed = email.trim();
    if (!trimmed) { setEmailError('Email is required'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setEmailError('Enter a valid email address');
      return;
    }
    setEmailError('');
    setIsLoading(true);
    try {
      // Enumeration-opaque: the backend returns 200 for ANY valid email (an OTP is
      // sent only on a match). We advance to 'otp' on success WITHOUT branching on
      // known/unknown — an unknown email still advances; the user just never gets a
      // code. Only a transport/throttle error keeps us on 'email'.
      await authService.requestPasswordReset(trimmed);
      setOtp(['', '', '', '', '', '']);
      setState('otp');
      setTimeout(() => otpInputRef.current?.focus(), 300);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 429) {
        setEmailError('Too many attempts. Wait a while and try again.');
      } else {
        setEmailError('Something went wrong. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function handleReset() {
    // Fast-fail client checks BEFORE the call. The server still enforces its own
    // password policy (400 {new_password:[...]}), which we surface below.
    if (!newPassword) { setPasswordError('Enter your new password'); return; }
    if (newPassword.length < 8) { setPasswordError('Password must be at least 8 characters'); return; }
    if (newPassword !== confirmPassword) { setPasswordError('Passwords do not match'); return; }
    setPasswordError('');
    setResetError('');
    setIsLoading(true);
    try {
      const otpCode = otp.join('');
      await authService.confirmPasswordReset(email.trim(), otpCode, newPassword);
      setState('success');
    } catch (err) {
      const data = axios.isAxiosError(err)
        ? (err.response?.data as { detail?: string; new_password?: string[] } | undefined)
        : undefined;
      if (data?.new_password?.length) {
        // Server password policy beyond the client length≥8 check — under the field.
        setPasswordError(data.new_password.join(' '));
      } else if (data?.detail) {
        // Collapsed OTP failure (wrong/expired/used/exhausted) — single message.
        setResetError(data.detail);
      } else {
        setResetError('Something went wrong. Please try again.');
      }
      // Stay on the step with inputs intact so the user can correct and retry.
    } finally {
      setIsLoading(false);
    }
  }

  // ── Email state ───────────────────────────────────────────────────────────

  if (state === 'email') {
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.root}>
        <View pointerEvents="none" style={styles.bgOrnamentA} />
        <View pointerEvents="none" style={styles.bgOrnamentB} />
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <ScrollView
            contentContainerStyle={[styles.content, isWideWeb && styles.contentWideCenter]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Screen variant="form">
            <TouchableOpacity
              style={styles.backBtn}
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <Ionicons name="arrow-back" size={22} color={Colors.primary} />
            </TouchableOpacity>

            <View style={styles.card}>
            <Wordmark />

            <View style={styles.iconCircle}>
              <Ionicons name="lock-open-outline" size={32} color={Colors.primary} />
            </View>

            <Text style={styles.heading}>Reset Password</Text>
            <Text style={styles.subtext}>
              Enter the email registered with your account. We'll send a 6-digit verification code.
            </Text>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Email address</Text>
              <TextInput
                style={[styles.input, emailError ? styles.inputError : null]}
                placeholder="you@church.org"
                placeholderTextColor={Colors.textMuted}
                keyboardType="email-address"
                autoCapitalize="none"
                returnKeyType="done"
                value={email}
                onChangeText={v => { setEmail(v); setEmailError(''); }}
                accessibilityLabel="Email address"
              />
              {emailError ? <Text style={styles.fieldError}>{emailError}</Text> : null}
            </View>

            <TouchableOpacity
              style={[styles.primaryBtn, isLoading && styles.primaryBtnDisabled]}
              onPress={handleSendOtp}
              disabled={isLoading}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Send OTP"
              accessibilityState={{ disabled: isLoading }}
            >
              {isLoading
                ? <ActivityIndicator color={Colors.white} size="small" />
                : <Text style={styles.primaryBtnText}>Send OTP</Text>
              }
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.secondaryLink}
              onPress={() => router.push('/login')}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Back to sign in"
            >
              <Text style={styles.secondaryLinkText}>Back to Sign In</Text>
            </TouchableOpacity>
            </View>
            </Screen>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // ── OTP + new password state ──────────────────────────────────────────────

  if (state === 'otp') {
    const allFilled = otp.every(d => d !== '');
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.root}>
        <View pointerEvents="none" style={styles.bgOrnamentA} />
        <View pointerEvents="none" style={styles.bgOrnamentB} />
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Screen variant="form">
            <TouchableOpacity
              style={styles.backBtn}
              onPress={() => setState('email')}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <Ionicons name="arrow-back" size={22} color={Colors.primary} />
            </TouchableOpacity>

            <View style={styles.card}>
            <Wordmark />

            <Text style={styles.heading}>Verify & Reset</Text>
            <Text style={styles.subtext}>
              If an account exists for{' '}
              <Text style={styles.emailHighlight}>{email}</Text>
              , a 6-digit code was sent. Enter it below and set your new password.
            </Text>

            <Text style={styles.label}>Verification code</Text>
            <View style={styles.otpWrapper}>
              <OTPInput
                ref={otpInputRef}
                value={otp}
                onChange={v => { setOtp(v); setResetError(''); }}
                disabled={isLoading}
              />
            </View>

            {resetError ? (
              <View style={styles.errorBanner}>
                <Ionicons name="alert-circle-outline" size={16} color={Colors.danger} />
                <Text style={styles.errorText}>{resetError}</Text>
              </View>
            ) : null}

            {/* New password */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>New password</Text>
              <View style={[styles.passwordRow, passwordError ? styles.passwordRowError : null]}>
                <TextInput
                  style={styles.passwordInput}
                  placeholder="Min. 8 characters"
                  placeholderTextColor={Colors.textMuted}
                  secureTextEntry={!showNew}
                  value={newPassword}
                  onChangeText={v => { setNewPassword(v); setPasswordError(''); }}
                  returnKeyType="next"
                  accessibilityLabel="New password"
                />
                <TouchableOpacity
                  style={styles.eyeBtn}
                  onPress={() => setShowNew(s => !s)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={showNew ? 'Hide password' : 'Show password'}
                >
                  <Ionicons
                    name={showNew ? 'eye-off-outline' : 'eye-outline'}
                    size={20}
                    color={Colors.textMuted}
                  />
                </TouchableOpacity>
              </View>
            </View>

            {/* Confirm password */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Confirm new password</Text>
              <View style={[styles.passwordRow, passwordError ? styles.passwordRowError : null]}>
                <TextInput
                  style={styles.passwordInput}
                  placeholder="Re-enter new password"
                  placeholderTextColor={Colors.textMuted}
                  secureTextEntry={!showConfirm}
                  value={confirmPassword}
                  onChangeText={v => { setConfirmPassword(v); setPasswordError(''); }}
                  returnKeyType="done"
                  accessibilityLabel="Confirm new password"
                />
                <TouchableOpacity
                  style={styles.eyeBtn}
                  onPress={() => setShowConfirm(s => !s)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={showConfirm ? 'Hide password' : 'Show password'}
                >
                  <Ionicons
                    name={showConfirm ? 'eye-off-outline' : 'eye-outline'}
                    size={20}
                    color={Colors.textMuted}
                  />
                </TouchableOpacity>
              </View>
            </View>

            {passwordError ? (
              <View style={styles.errorBanner}>
                <Ionicons name="alert-circle-outline" size={16} color={Colors.danger} />
                <Text style={styles.errorText}>{passwordError}</Text>
              </View>
            ) : null}

            <TouchableOpacity
              style={[
                styles.primaryBtn,
                (!allFilled || isLoading) && styles.primaryBtnDisabled,
              ]}
              onPress={handleReset}
              disabled={!allFilled || isLoading}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Reset password"
              accessibilityState={{ disabled: !allFilled || isLoading }}
            >
              {isLoading
                ? <ActivityIndicator color={Colors.white} size="small" />
                : <Text style={styles.primaryBtnText}>Reset Password</Text>
              }
            </TouchableOpacity>
            </View>
            </Screen>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // ── Success state ─────────────────────────────────────────────────────────

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.root}>
      <View pointerEvents="none" style={styles.bgOrnamentA} />
      <View pointerEvents="none" style={styles.bgOrnamentB} />
      <View style={styles.successContainer}>
        <View style={styles.successIconCircle}>
          <Ionicons name="checkmark-circle" size={48} color={Colors.success} />
        </View>
        <Text style={styles.successHeading}>Password reset!</Text>
        <Text style={styles.successBody}>
          Your password has been updated. Sign in with your new password.
        </Text>
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={() => router.replace('/login')}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Go to sign in"
        >
          <Text style={styles.primaryBtnText}>Go to Sign In</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.surfaceSubtle,
  },
  flex: { flex: 1 },

  // Background ornaments — oversized, very quiet
  bgOrnamentA: {
    position: 'absolute',
    top: -130,
    right: -110,
    width: 360,
    height: 360,
    borderRadius: 180,
    backgroundColor: 'rgba(5,124,138,0.06)',
  },
  bgOrnamentB: {
    position: 'absolute',
    bottom: -150,
    left: -130,
    width: 400,
    height: 400,
    borderRadius: 200,
    backgroundColor: 'rgba(5,124,138,0.05)',
  },

  // The floating auth card
  card: {
    backgroundColor: Colors.white,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.xl,
    ...Shadows.lg,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xl,
  },
  // Wide web: short form floats vertically centered
  contentWideCenter: {
    justifyContent: 'center',
    paddingTop: Spacing.xl,
  },

  backBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
    ...Shadows.sm,
  },

  wordmark: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxxl,
    marginBottom: Spacing.lg,
    textAlign: 'center',
  },
  wordmarkPamoja: { color: Colors.primary },
  wordmarkHub: { color: Colors.accent },

  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
    alignSelf: 'center',
  },

  heading: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.title,
    color: Colors.text,
    marginBottom: 4,
    textAlign: 'center',
  },
  subtext: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
    lineHeight: FontSize.md * 1.6,
    marginBottom: Spacing.xl,
    textAlign: 'center',
  },
  emailHighlight: {
    fontFamily: 'Poppins-SemiBold',
    color: Colors.text,
  },

  fieldGroup: {
    marginBottom: Spacing.md,
  },
  label: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: 6,
  },
  input: {
    height: 50,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.lg,
    paddingHorizontal: Spacing.md,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.base,
    color: Colors.text,
    backgroundColor: Colors.white,
  },
  inputError: {
    borderColor: Colors.danger,
  },
  fieldError: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.danger,
    marginTop: 4,
  },

  otpWrapper: {
    marginBottom: Spacing.xl,
  },

  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.white,
    height: 50,
  },
  passwordRowError: {
    borderColor: Colors.danger,
  },
  passwordInput: {
    flex: 1,
    height: '100%',
    paddingHorizontal: Spacing.md,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.base,
    color: Colors.text,
  },
  eyeBtn: {
    width: Spacing.touch,
    height: Spacing.touch,
    alignItems: 'center',
    justifyContent: 'center',
  },

  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    backgroundColor: Colors.dangerLight,
    borderRadius: BorderRadius.lg,
    paddingVertical: 10,
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.md,
  },
  errorText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.danger,
    flex: 1,
  },

  primaryBtn: {
    backgroundColor: Colors.accent,
    borderRadius: BorderRadius.pill,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
    width: '100%',
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.white,
  },

  secondaryLink: {
    alignItems: 'center',
    paddingVertical: Spacing.sm,
  },
  secondaryLinkText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },

  successContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.xxl,
    gap: Spacing.md,
    maxWidth: 480,
    alignSelf: 'center',
    marginHorizontal: Spacing.md,
    marginTop: 'auto',
    marginBottom: 'auto',
    backgroundColor: Colors.white,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    ...Shadows.lg,
  },
  successIconCircle: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: Colors.successLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successHeading: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxl,
    color: Colors.text,
    textAlign: 'center',
  },
  successBody: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: FontSize.md * 1.7,
    marginBottom: Spacing.sm,
  },
});
