import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
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
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { useAuth } from '../../stores/auth.store';
import { AuthUser } from '../../types';
import { resolveAuthDestination } from '../../utils/authRouting';

function Wordmark() {
  return (
    <Text style={styles.wordmark}>
      <Text style={styles.wordmarkPamoja}>Pamoja</Text>
      <Text style={styles.wordmarkHub}>Hub</Text>
    </Text>
  );
}

// Inline message shown when a treasurer logs in but their church isn't ACTIVE.
// (Follow-on slice: dedicated status screens; for now this reuses the login banner.)
function churchStatusMessage(user: AuthUser): string {
  switch (user.churchStatus) {
    case 'PENDING':
      return 'Your church registration is awaiting approval. You will be notified once it is reviewed.';
    case 'REJECTED':
      return user.churchRejectionReason
        ? `Your church registration was not approved: ${user.churchRejectionReason}`
        : 'Your church registration was not approved. Please contact support.';
    case 'SUSPENDED':
      return 'Your church account is suspended. Please contact support to restore access.';
    default:
      return 'Your church account is not active. Please contact support.';
  }
}

export default function LoginScreen() {
  const router = useRouter();
  const { login, user } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loginError, setLoginError] = useState('');

  // If a restored session (root guard) lands a non-ACTIVE treasurer here, show the
  // SAME church-status message login would — same shared decision, no divergence.
  useEffect(() => {
    if (user && resolveAuthDestination(user) === '/login') {
      setLoginError(churchStatusMessage(user));
    }
  }, [user]);

  // After a login → logout the auth stack is reset via router.replace('/login'),
  // so login becomes the ONLY history entry and router.back() throws
  // "The action 'GO_BACK' was not handled by any navigator". Guard on canGoBack():
  // pop real history when it exists (e.g. arrived from the landing), otherwise fall
  // back to the public landing page so the control always has a destination.
  function handleBack() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }

  async function handleSignIn() {
    if (!email.trim() || !password) {
      setLoginError('Enter your email and password to sign in.');
      return;
    }
    setLoginError('');
    setIsLoading(true);
    try {
      const loggedInUser = await login(email.trim(), password);

      // Shared routing decision (same one the restore guard uses). A non-ACTIVE
      // treasurer resolves to '/login' — stay here and show the church-status
      // message instead of routing into a dashboard that assumes ACTIVE.
      // NOTE (follow-on slice): inline messages, not dedicated status screens.
      const dest = resolveAuthDestination(loggedInUser);
      if (dest === '/login') {
        setLoginError(churchStatusMessage(loggedInUser));
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      router.replace(dest as any);
    } catch (err) {
      // Surface the REAL server message (401 'Invalid email or password.', 429
      // rate-limit detail, etc.) instead of a hardcoded string.
      const detail = axios.isAxiosError(err)
        ? (err.response?.data as { detail?: string } | undefined)?.detail
        : undefined;
      setLoginError(detail ?? 'Something went wrong. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.root}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity
            style={styles.backBtn}
            onPress={handleBack}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="arrow-back" size={22} color={Colors.text} />
          </TouchableOpacity>

          <Wordmark />

          <Text style={styles.heading}>Sign in</Text>
          <Text style={styles.subtext}>Treasurer access</Text>

          {/* Email */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Email address</Text>
            <TextInput
              style={styles.input}
              placeholder="you@church.org"
              placeholderTextColor={Colors.textMuted}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              returnKeyType="next"
              value={email}
              onChangeText={v => { setEmail(v); setLoginError(''); }}
              accessibilityLabel="Email address"
            />
          </View>

          {/* Password */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Password</Text>
            <View style={styles.passwordRow}>
              <TextInput
                style={styles.passwordInput}
                placeholder="Enter your password"
                placeholderTextColor={Colors.textMuted}
                secureTextEntry={!showPassword}
                autoComplete="password"
                returnKeyType="done"
                value={password}
                onChangeText={v => { setPassword(v); setLoginError(''); }}
                accessibilityLabel="Password"
              />
              <TouchableOpacity
                style={styles.eyeBtn}
                onPress={() => setShowPassword(s => !s)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
              >
                <Ionicons
                  name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                  size={20}
                  color={Colors.textMuted}
                />
              </TouchableOpacity>
            </View>
          </View>

          {/* Inline error */}
          {loginError ? (
            <View style={styles.errorBanner}>
              <Ionicons name="alert-circle-outline" size={16} color={Colors.danger} />
              <Text style={styles.errorText}>{loginError}</Text>
            </View>
          ) : null}

          {/* Sign In button */}
          <TouchableOpacity
            style={[styles.primaryBtn, isLoading && styles.primaryBtnDisabled]}
            onPress={handleSignIn}
            disabled={isLoading}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Sign in"
            accessibilityState={{ disabled: isLoading }}
          >
            {isLoading
              ? <ActivityIndicator color={Colors.white} size="small" />
              : <Text style={styles.primaryBtnText}>Sign In</Text>
            }
          </TouchableOpacity>

          {/* Forgot password */}
          <TouchableOpacity
            style={styles.forgotBtn}
            onPress={() => router.push('/reset-password')}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Forgot password"
          >
            <Text style={styles.forgotText}>Forgot password?</Text>
          </TouchableOpacity>

          <View style={styles.divider} />

          {/* Register link */}
          <View style={styles.registerRow}>
            <Text style={styles.registerLabel}>{"Don't have an account?  "}</Text>
            <TouchableOpacity
              onPress={() => router.push('/register')}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Register your church"
            >
              <Text style={styles.registerLink}>Register your church</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xl,
  },

  backBtn: {
    width: Spacing.touch,
    height: Spacing.touch,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -Spacing.sm,
    marginBottom: Spacing.md,
  },

  wordmark: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxxl,
    marginBottom: Spacing.lg,
  },
  wordmarkPamoja: { color: Colors.primary },
  wordmarkHub: { color: Colors.accent },

  heading: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.title,
    color: Colors.text,
    marginBottom: 4,
  },
  subtext: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
    marginBottom: Spacing.xl,
  },

  fieldGroup: {
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
    fontSize: FontSize.base,
    color: Colors.text,
    backgroundColor: Colors.white,
  },

  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.white,
    height: Spacing.touch,
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
    borderRadius: BorderRadius.md,
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
    borderRadius: BorderRadius.md,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.white,
  },

  forgotBtn: {
    alignItems: 'center',
    paddingVertical: Spacing.xs,
    marginBottom: Spacing.lg,
  },
  forgotText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },

  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginBottom: Spacing.lg,
  },

  registerRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  registerLabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  registerLink: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },
});
