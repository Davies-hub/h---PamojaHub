import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
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
import Screen from '../../components/layout/Screen';
import CountyPicker from '../../components/ui/CountyPicker';
import { BorderRadius, Colors, FontSize, Shadows, Spacing } from '../../constants/theme';
import { authService } from '../../services/auth.service';

interface FormErrors {
  churchName?: string;
  email?: string;
  phone?: string;
  address?: string;
  denomination?: string;
  password?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Wordmark() {
  return (
    <Text style={styles.wordmark}>
      <Text style={styles.wordmarkPamoja}>Pamoja</Text>
      <Text style={styles.wordmarkHub}>Hub</Text>
    </Text>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
}

function SuccessScreen({ onHome }: { onHome: () => void }) {
  return (
    <View style={styles.successContainer}>
      <View style={styles.successIconCircle}>
        <Ionicons name="checkmark-circle" size={48} color={Colors.success} />
      </View>
      <Text style={styles.successHeading}>Application submitted.</Text>
      <Text style={styles.successBody}>
        We will review your application and contact you within 2 business days.
      </Text>
      <TouchableOpacity
        style={[styles.primaryBtn, styles.successHomeBtn]}
        onPress={onHome}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Back to home"
      >
        <Ionicons name="home-outline" size={18} color={Colors.white} />
        <Text style={styles.primaryBtnText}>Back to Home</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

// ─── Profile Picture ──────────────────────────────────────────────────────────

function ProfilePhotoSection({
  uri,
  onPress,
}: {
  uri: string | null;
  onPress: () => void;
}) {
  return (
    <View style={styles.photoSection}>
      <TouchableOpacity
        style={styles.photoCircle}
        onPress={onPress}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="Add church profile photo"
      >
        {uri ? (
          <Image source={{ uri }} style={styles.photoImage} />
        ) : (
          <View style={styles.photoPlaceholder}>
            <Ionicons name="business" size={40} color={Colors.primary} />
          </View>
        )}
        <View style={styles.photoBadge}>
          <Ionicons name="camera" size={14} color={Colors.white} />
        </View>
      </TouchableOpacity>
      <Text style={styles.photoLabel}>Church Logo / Photo</Text>
      <Text style={styles.photoSubLabel}>Tap to add (optional)</Text>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function RegisterScreen() {
  const router = useRouter();

  const [profilePhoto, setProfilePhoto] = useState<string | null>(null);
  const [churchName, setChurchName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [county, setCounty] = useState('');   // optional — blank submits fine
  const [denomination, setDenomination] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [generalError, setGeneralError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  function handlePhotoPress() {
    Alert.alert(
      'Church Profile Photo',
      'Photo upload will be available once the backend is connected. You can add your church logo at that time.',
      [{ text: 'OK' }],
    );
  }

  function clearError(field: keyof FormErrors) {
    setErrors(e => ({ ...e, [field]: undefined }));
  }

  function validate(): boolean {
    const e: FormErrors = {};
    if (!churchName.trim()) e.churchName = 'Church name is required';
    if (!email.trim()) {
      e.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      e.email = 'Enter a valid email address';
    }
    if (!phone.trim()) {
      e.phone = 'Phone number is required';
    } else if (!/^(07|01)\d{8}$/.test(phone.replace(/\s/g, ''))) {
      e.phone = 'Enter a valid Kenyan number (07xx or 01xx)';
    }
    // address is REQUIRED by the backend (Option A) — block empty before the call.
    if (!address.trim()) e.address = 'Physical address is required';
    if (!denomination.trim()) e.denomination = 'Denomination is required';
    // Basic presence only — the backend runs Django's password validators and
    // returns field-level errors (too short / too common / numeric) which we surface.
    if (!password) e.password = 'Password is required';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleRegister() {
    setGeneralError('');
    if (!validate()) return;
    setIsSubmitting(true);
    try {
      await authService.register({
        churchName: churchName.trim(),
        email: email.trim(),
        phone: phone.replace(/\s/g, ''),   // 0712… as typed; backend normalizes to 254…
        address: address.trim(),
        county: county.trim(),             // optional — mapper omits it when blank
        denomination: denomination.trim(),
        password,
      });
      setSubmitted(true);   // 201 → await-approval screen (no auto-login, church PENDING)
    } catch (err) {
      // Surface the REAL backend errors. Field errors arrive as {field:[msg,...]};
      // a top-level {detail:...} (e.g. the duplicate-email race) goes to the banner.
      if (axios.isAxiosError(err) && err.response) {
        const data = (err.response.data ?? {}) as Record<string, unknown>;
        const pick = (k: string): string | undefined => {
          const v = data[k];
          if (Array.isArray(v)) return String(v[0]);
          if (typeof v === 'string') return v;
          return undefined;
        };
        const mapped: FormErrors = {
          churchName: pick('name'),
          email: pick('official_email'),
          phone: pick('phone'),
          address: pick('address'),
          denomination: pick('denomination'),
          password: pick('password'),
        };
        setErrors(mapped);
        const detail = pick('detail');
        if (detail) setGeneralError(detail);
        else if (!Object.values(mapped).some(Boolean)) {
          setGeneralError('Registration failed. Please check your details and try again.');
        }
      } else {
        setGeneralError('Something went wrong. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.root}>
        <View pointerEvents="none" style={styles.bgOrnamentA} />
        <View pointerEvents="none" style={styles.bgOrnamentB} />
        <SuccessScreen onHome={() => router.replace('/')} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.root}>
      {/* Decorative — oversized brand circles behind the card */}
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
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="arrow-back" size={22} color={Colors.primary} />
          </TouchableOpacity>

          <View style={styles.card}>
          <ProfilePhotoSection uri={profilePhoto} onPress={handlePhotoPress} />
          <Wordmark />
          <Text style={styles.heading}>Register Your Church</Text>
          <View style={styles.helperBox}>
            <Ionicons name="information-circle-outline" size={18} color={Colors.primaryDark} style={styles.helperIcon} />
            <Text style={styles.helperText}>
              The person completing this form becomes the designated Church Treasurer — the primary contact for payouts and campaign management.
            </Text>
          </View>

          {/* Church name */}
          <Field label="Church name" error={errors.churchName}>
            <TextInput
              style={[styles.input, errors.churchName ? styles.inputError : null]}
              placeholder="e.g. PCEA Bahati Martyrs"
              placeholderTextColor={Colors.textMuted}
              value={churchName}
              onChangeText={v => { setChurchName(v); clearError('churchName'); }}
              returnKeyType="next"
              accessibilityLabel="Church name"
            />
          </Field>

          {/* Official email */}
          <Field label="Official email" error={errors.email}>
            <TextInput
              style={[styles.input, errors.email ? styles.inputError : null]}
              placeholder="treasurer@church.org"
              placeholderTextColor={Colors.textMuted}
              keyboardType="email-address"
              autoCapitalize="none"
              value={email}
              onChangeText={v => { setEmail(v); clearError('email'); }}
              returnKeyType="next"
              accessibilityLabel="Official email"
            />
          </Field>

          {/* Phone number */}
          <Field label="Phone number" error={errors.phone}>
            <TextInput
              style={[styles.input, errors.phone ? styles.inputError : null]}
              placeholder="0712 345 678"
              placeholderTextColor={Colors.textMuted}
              keyboardType="phone-pad"
              value={phone}
              onChangeText={v => { setPhone(v); clearError('phone'); }}
              returnKeyType="next"
              maxLength={13}
              accessibilityLabel="Phone number"
            />
          </Field>

          {/* Physical address (required) */}
          <Field label="Physical address" error={errors.address}>
            <TextInput
              style={[styles.input, errors.address ? styles.inputError : null]}
              placeholder="e.g. Bahati Estate, Nairobi"
              placeholderTextColor={Colors.textMuted}
              value={address}
              onChangeText={v => { setAddress(v); clearError('address'); }}
              returnKeyType="next"
              accessibilityLabel="Physical address"
            />
          </Field>

          {/* County (optional) */}
          <Field label="County (optional)">
            <CountyPicker value={county} onChange={setCounty} />
          </Field>

          {/* Denomination */}
          <Field label="Denomination" error={errors.denomination}>
            <TextInput
              style={[styles.input, errors.denomination ? styles.inputError : null]}
              placeholder="e.g. PCEA, ACK, SDA, Catholic"
              placeholderTextColor={Colors.textMuted}
              value={denomination}
              onChangeText={v => { setDenomination(v); clearError('denomination'); }}
              returnKeyType="next"
              accessibilityLabel="Denomination"
            />
          </Field>

          {/* Password */}
          <Field label="Password" error={errors.password}>
            <View style={[styles.passwordRow, errors.password ? styles.inputError : null]}>
              <TextInput
                style={styles.passwordInput}
                placeholder="Create a password"
                placeholderTextColor={Colors.textMuted}
                secureTextEntry={!showPassword}
                value={password}
                onChangeText={v => { setPassword(v); clearError('password'); }}
                returnKeyType="done"
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
          </Field>

          {/* General (top-level) error banner */}
          {generalError ? (
            <View style={styles.errorBanner}>
              <Ionicons name="alert-circle-outline" size={16} color={Colors.danger} />
              <Text style={styles.errorText}>{generalError}</Text>
            </View>
          ) : null}

          {/* Submit */}
          <TouchableOpacity
            style={[styles.primaryBtn, isSubmitting && styles.primaryBtnDisabled]}
            onPress={handleRegister}
            disabled={isSubmitting}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Register church"
            accessibilityState={{ disabled: isSubmitting }}
          >
            {isSubmitting
              ? <ActivityIndicator color={Colors.white} size="small" />
              : <Text style={styles.primaryBtnText}>Register Church</Text>
            }
          </TouchableOpacity>

          {/* Sign in link */}
          <View style={styles.signInRow}>
            <Text style={styles.signInLabel}>Already registered?  </Text>
            <TouchableOpacity
              onPress={() => router.push('/login')}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Sign in"
            >
              <Text style={styles.signInLink}>Sign in</Text>
            </TouchableOpacity>
          </View>
          </View>
          </Screen>
        </ScrollView>
      </KeyboardAvoidingView>

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
  content: {
    flexGrow: 1,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xl,
  },

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

  // Profile photo
  photoSection: {
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  photoCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: Colors.primaryLight,
    borderWidth: 2,
    borderColor: Colors.primary,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
    position: 'relative',
  },
  photoPlaceholder: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoImage: {
    width: 92,
    height: 92,
    borderRadius: 46,
  },
  photoBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.white,
  },
  photoLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.text,
    marginTop: 10,
  },
  photoSubLabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 2,
  },

  wordmark: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxxl,
    marginBottom: Spacing.sm,
    textAlign: 'center',
  },
  wordmarkPamoja: { color: Colors.primary },
  wordmarkHub: { color: Colors.accent },

  heading: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.title,
    color: Colors.text,
    marginBottom: Spacing.md,
    textAlign: 'center',
  },
  helperBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 4,
    marginBottom: Spacing.xl,
  },
  helperIcon: {
    marginTop: 2,
  },
  helperText: {
    flex: 1,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.primaryDark,
    lineHeight: FontSize.sm * 1.65,
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

  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.white,
    height: 50,
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
    marginTop: Spacing.xs,
    marginBottom: Spacing.md,
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.white,
  },
  successHomeBtn: {
    flexDirection: 'row',
    gap: 10,
    marginTop: Spacing.xl,
    marginBottom: 0,
  },

  signInRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  signInLabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  signInLink: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },

  // Success state — floating card on the tinted page
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
