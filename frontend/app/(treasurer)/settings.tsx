import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsWideWeb } from '../../components/layout/Screen';
import SubscriptionCard from '../../components/treasurer/SubscriptionCard';
import Card from '../../components/ui/Card';
import CountyPicker from '../../components/ui/CountyPicker';
import ImageViewer from '../../components/ui/ImageViewer';
import RemoteImage from '../../components/ui/RemoteImage';
import Spinner from '../../components/ui/Spinner';
import Toast from '../../components/ui/Toast';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { useFocusRefetch } from '../../hooks/useFocusRefetch';
import { churchesService } from '../../services/churches.service';
import { useAuth } from '../../stores/auth.store';

// The 6 writable profile fields — the ONLY keys the backend accepts on PATCH
// /churches/me/ AND the field-error keys it returns (all single words → snake == camel).
const WRITABLE_FIELDS = ['name', 'denomination', 'phone', 'address', 'county', 'description'] as const;

// Pull a top-level {"detail": "..."} message out of a DRF error body.
function extractDetail(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'detail' in data) {
    const d = (data as { detail?: unknown }).detail;
    if (typeof d === 'string') return d;
  }
  return undefined;
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ title, color }: { title: string; color?: string }) {
  return (
    <Text style={[styles.sectionHeader, color ? { color } : null]}>
      {title}
    </Text>
  );
}

// ─── Field label ──────────────────────────────────────────────────────────────

function FieldLabel({ label }: { label: string }) {
  return <Text style={styles.fieldLabel}>{label}</Text>;
}

// ─── Row item (account + danger zone rows) ────────────────────────────────────

function RowItem({
  label,
  value,
  onPress,
  showChevron = false,
  labelColor,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
  showChevron?: boolean;
  labelColor?: string;
}) {
  const content = (
    <View style={styles.rowItem}>
      <Text style={[styles.rowLabel, labelColor ? { color: labelColor } : null]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <View style={styles.rowRight}>
        {value ? <Text style={styles.rowValue} numberOfLines={1}>{value}</Text> : null}
        {showChevron
          ? <Ionicons name="chevron-forward" size={18} color={Colors.textMuted} />
          : null}
      </View>
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.7} accessibilityRole="button">
        {content}
      </TouchableOpacity>
    );
  }
  return content;
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function SettingsScreen() {
  const isWideWeb = useIsWideWeb();
  const router = useRouter();
  const { user } = useAuth();

  // LIVE church profile (server truth). Same hook the SubscriptionCard uses, but a
  // SEPARATE read (the card is standalone — see its comment). Background-refetch on
  // focus keeps last-good on a revisit; the editable form below mirrors `church`.
  const { data: church, status: fetchStatus, refetchError, retry } = useFocusRefetch(
    () => churchesService.getMyChurch(),
  );

  // Church profile form state — MIRRORS the fetched church (seeded/re-synced on every
  // new server snapshot). Editing locally then navigating away (refocus → refetch)
  // discards unsaved edits — accepted for a settings form (matches the Queue MIRROR).
  // NOTE: Official Email is DELIBERATELY NOT a form field — it is read-only on the
  // backend and already shown in the Account card (useAuth). No editable email input.
  const [churchName, setChurchName]     = useState('');
  const [phone, setPhone]               = useState('');
  const [address, setAddress]           = useState('');
  const [county, setCounty]             = useState('');
  const [denomination, setDenomination] = useState('');
  const [description, setDescription]   = useState('');

  const [isSaving, setIsSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  // Full-size logo overlay (tap the circle → see the whole frame uncropped).
  const [logoViewerOpen, setLogoViewerOpen] = useState(false);
  // One toast surface shared by profile-save AND logo-upload (success OR error).
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  // Per-field 400 errors keyed by backend field name (phone/name/…); a non-field
  // {"detail":…}, a 403 (suspended), or an unknown failure → generalError.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | undefined>(undefined);

  // Seed / re-sync the form whenever a fresh church snapshot arrives.
  useEffect(() => {
    if (!church) return;
    setChurchName(church.name);
    setPhone(church.phone);
    setAddress(church.address);
    setCounty(church.county ?? '');
    setDenomination(church.denomination);
    setDescription(church.description ?? '');
  }, [church]);

  function showToast(type: 'success' | 'error', message: string) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  }

  // Map an axios failure to per-field + general error surfaces (no silent failure).
  function applyError(e: unknown) {
    if (axios.isAxiosError(e) && e.response) {
      const { status: code, data } = e.response;
      if (code === 400 && data && typeof data === 'object') {
        const fe: Record<string, string> = {};
        for (const k of WRITABLE_FIELDS) {
          const v = (data as Record<string, unknown>)[k];
          if (Array.isArray(v) && typeof v[0] === 'string') fe[k] = v[0];
          else if (typeof v === 'string') fe[k] = v;
        }
        if (Object.keys(fe).length > 0) {
          setFieldErrors(fe);
          return;
        }
        setGeneralError(extractDetail(data) ?? 'Could not save your changes. Please check the fields and try again.');
        return;
      }
      if (code === 403) {
        setGeneralError(extractDetail(data) ?? 'Your church is suspended — profile changes are disabled.');
        return;
      }
    }
    setGeneralError('Something went wrong saving your changes. Please try again.');
  }

  async function handleSave() {
    if (isSaving) return;
    setFieldErrors({});
    setGeneralError(undefined);
    setIsSaving(true);
    try {
      // Sends ONLY the 6 writable fields; the response is server truth (normalized phone).
      const updated = await churchesService.updateMyChurch({
        name: churchName,
        denomination,
        phone,
        address,
        county,
        description,
      });
      // Reflect server truth (e.g. 0712… → 254712…) back into the form.
      setChurchName(updated.name);
      setPhone(updated.phone);
      setAddress(updated.address);
      setCounty(updated.county ?? '');
      setDenomination(updated.denomination);
      setDescription(updated.description ?? '');
      setIsSaving(false);
      showToast('success', 'Church profile updated.');
    } catch (e) {
      setIsSaving(false);
      applyError(e);
    }
  }

  function handleChangePassword() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.push('/(auth)/reset-password' as any);
  }

  // Pick an image → upload to /churches/me/logo/ (multipart) → re-read the church so
  // RemoteImage shows the server-set logo_url. All FE checks here are UX ONLY — the
  // backend re-validates permission/size/format/re-encode regardless (Slice 3).
  async function handleChangeLogo() {
    if (uploadingLogo) return;

    // web: picker must be first await in the click handler — an intervening await
    // burns transient user activation and Chrome silently refuses the file dialog
    // (promise never settles). Permission gate is native-only (web always grants).
    if (Platform.OS !== 'web') {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission needed', 'Allow photo access to change your church logo.', [{ text: 'OK' }]);
        return;
      }
    }

    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.9,
    });
    if (res.canceled) return;
    const asset = res.assets[0];

    // UX-only pre-check — a friendly early reject; the server re-checks the real size.
    if (asset.fileSize && asset.fileSize > 5 * 1024 * 1024) {
      showToast('error', 'Image must be under 5 MB.');
      return;
    }

    setUploadingLogo(true);
    try {
      await churchesService.uploadLogo({
        uri: asset.uri,
        fileName: asset.fileName ?? undefined,
        mimeType: asset.mimeType ?? undefined,
      });
      retry();                             // re-read church → RemoteImage shows the new logo (server truth)
      showToast('success', 'Logo updated.');
    } catch (e) {
      // Surface the server's 400 detail (too large / bad format / re-encode reject land here).
      let msg = 'Could not upload the logo. Please try again.';
      if (axios.isAxiosError(e) && e.response) {
        msg = extractDetail(e.response.data) ?? msg;
      }
      showToast('error', msg);
    } finally {
      setUploadingLogo(false);
    }
  }

  function handleCloseAccount() {
    const subject = encodeURIComponent(`Account closure request — ${churchName}`);
    Linking.openURL(`mailto:support@pamojahub.co.ke?subject=${subject}`);
  }

  // Church initials for logo circle
  const initials = churchName
    .split(' ')
    .filter(w => w.length > 0)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('');

  // The 76px circle itself — declared once and shared by the tappable and
  // non-tappable branches below, so the fallback markup isn't duplicated.
  const logoThumbnail = (
    <RemoteImage
      uri={church?.logoUrl}
      style={styles.logoCircle}
      resizeMode="cover"
      fallback={
        <View style={styles.logoCircle}>
          <Text style={styles.logoInitials}>{initials}</Text>
        </View>
      }
    />
  );

  return (
    <SafeAreaView edges={['bottom']} style={styles.root}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[styles.content, isWideWeb && styles.wideCap]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Toast — profile-save + logo-upload success/error share this surface */}
          {toast ? <Toast type={toast.type} message={toast.message} visible /> : null}

          {/* ── 1. Church Profile ────────────────────────────────────────── */}
          <SectionHeader title="Church Profile" />
          <Card style={styles.card}>
            {church === null && fetchStatus === 'loading' ? (
              // First load, nothing cached → spinner (reserves height, no jump).
              <View style={styles.fetchStateBox}>
                <Spinner size="small" />
                <Text style={styles.mutedNote}>Loading church profile…</Text>
              </View>
            ) : church === null ? (
              // First load FAILED with nothing to fall back to → error + retry.
              <View style={styles.fetchStateBox}>
                <Ionicons name="cloud-offline-outline" size={22} color={Colors.textMuted} />
                <Text style={styles.mutedNote}>Couldn&apos;t load your church profile.</Text>
                <TouchableOpacity
                  onPress={retry}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading church profile"
                >
                  <Text style={styles.retryLink}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                {/* Logo — real image if uploaded, initials circle otherwise */}
                <View style={styles.logoRow}>
                  {/* Tappable ONLY when a logo url exists: the initials circle is a
                      synthetic placeholder, so opening a full-size viewer on it would
                      show nothing. (A truthy-but-dead url still reaches the viewer —
                      that case is caught by ImageViewer's own onError, since
                      RemoteImage swallows load failures internally.) */}
                  {church?.logoUrl ? (
                    <TouchableOpacity
                      onPress={() => setLogoViewerOpen(true)}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel="View church logo full size"
                    >
                      {logoThumbnail}
                    </TouchableOpacity>
                  ) : (
                    logoThumbnail
                  )}
                  <TouchableOpacity
                    onPress={handleChangeLogo}
                    disabled={uploadingLogo}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel="Change church logo"
                    accessibilityState={{ busy: uploadingLogo, disabled: uploadingLogo }}
                  >
                    <Text style={[styles.changeLogoLink, uploadingLogo && styles.changeLogoLinkDisabled]}>
                      {uploadingLogo ? 'Uploading…' : 'Change Logo'}
                    </Text>
                  </TouchableOpacity>
                </View>

                <FieldLabel label="Church Name" />
                <TextInput
                  style={[styles.input, fieldErrors.name ? styles.inputErrorBorder : null]}
                  value={churchName}
                  onChangeText={setChurchName}
                  placeholder="Church name"
                  placeholderTextColor={Colors.textMuted}
                  returnKeyType="next"
                  accessibilityLabel="Church name"
                />
                {fieldErrors.name ? <Text style={styles.fieldError}>{fieldErrors.name}</Text> : null}

                <FieldLabel label="Phone" />
                <TextInput
                  style={[styles.input, fieldErrors.phone ? styles.inputErrorBorder : null]}
                  value={phone}
                  onChangeText={setPhone}
                  placeholder="0712 345 678"
                  placeholderTextColor={Colors.textMuted}
                  keyboardType="phone-pad"
                  maxLength={13}
                  accessibilityLabel="Phone number"
                />
                {fieldErrors.phone ? <Text style={styles.fieldError}>{fieldErrors.phone}</Text> : null}

                <FieldLabel label="Physical Address" />
                <TextInput
                  style={[styles.input, fieldErrors.address ? styles.inputErrorBorder : null]}
                  value={address}
                  onChangeText={setAddress}
                  placeholder="Estate, Town"
                  placeholderTextColor={Colors.textMuted}
                  returnKeyType="next"
                  accessibilityLabel="Physical address"
                />
                {fieldErrors.address ? <Text style={styles.fieldError}>{fieldErrors.address}</Text> : null}

                <FieldLabel label="County" />
                <View style={styles.fieldSpacing}>
                  <CountyPicker value={county} onChange={setCounty} error={fieldErrors.county} />
                </View>
                {fieldErrors.county ? <Text style={styles.fieldError}>{fieldErrors.county}</Text> : null}

                <FieldLabel label="Denomination" />
                <TextInput
                  style={[styles.input, fieldErrors.denomination ? styles.inputErrorBorder : null]}
                  value={denomination}
                  onChangeText={setDenomination}
                  placeholder="e.g. PCEA, ACK, SDA"
                  placeholderTextColor={Colors.textMuted}
                  returnKeyType="next"
                  accessibilityLabel="Denomination"
                />
                {fieldErrors.denomination ? <Text style={styles.fieldError}>{fieldErrors.denomination}</Text> : null}

                <FieldLabel label="Description" />
                <TextInput
                  style={[styles.input, styles.inputMultiline, fieldErrors.description ? styles.inputErrorBorder : null]}
                  value={description}
                  onChangeText={setDescription}
                  placeholder="Brief description of your church…"
                  placeholderTextColor={Colors.textMuted}
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                  accessibilityLabel="Church description"
                />
                {fieldErrors.description ? <Text style={styles.fieldError}>{fieldErrors.description}</Text> : null}

                {/* General (non-field) error surface — 403 suspended / {detail} / unknown. */}
                {generalError ? (
                  <View style={styles.generalErrorBox}>
                    <Ionicons name="alert-circle" size={16} color={Colors.danger} style={{ marginTop: 1 }} />
                    <Text style={styles.generalErrorText}>{generalError}</Text>
                  </View>
                ) : null}

                {/* Background refetch failed but last-good data is still shown. */}
                {refetchError ? (
                  <View style={styles.refetchRow}>
                    <Text style={styles.refetchText}>Couldn&apos;t refresh.</Text>
                    <TouchableOpacity onPress={retry} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Retry refreshing profile">
                      <Text style={styles.retryLink}>Retry</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}

                <TouchableOpacity
                  style={[styles.saveBtn, isSaving && styles.saveBtnDisabled]}
                  onPress={handleSave}
                  disabled={isSaving}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel="Save changes"
                  accessibilityState={{ busy: isSaving, disabled: isSaving }}
                >
                  <Text style={styles.saveBtnText}>{isSaving ? 'Saving…' : 'Save Changes'}</Text>
                </TouchableOpacity>
              </>
            )}
          </Card>

          {/* ── 2. Account ───────────────────────────────────────────────── */}
          <SectionHeader title="Account" />
          <Card style={styles.card} padding={0}>
            <RowItem
              label={user ? `${user.firstName} ${user.lastName}` : '—'}
              value={user?.email ?? '—'}
            />
            <View style={styles.cardDivider} />
            <RowItem
              label="Change Password"
              showChevron
              onPress={handleChangePassword}
            />
          </Card>

          {/* ── 3. Subscription ──────────────────────────────────────────── */}
          {/* Self-contained: its own useFocusRefetch(getMyChurch) read of the LIVE
              /churches/me/ tier + expiry (the editable profile form above stays mock
              this slice — it can't share the hook because its fields are editable). */}
          <SectionHeader title="Subscription" />
          <SubscriptionCard />

          {/* ── 4. Danger Zone ───────────────────────────────────────────── */}
          <SectionHeader title="Danger Zone" color={Colors.danger} />
          <Card style={styles.card} padding={0}>
            <TouchableOpacity
              style={styles.dangerRow}
              onPress={handleCloseAccount}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Contact PamojaHub support to close account"
            >
              <Text style={styles.dangerRowLabel}>
                Contact PamojaHub Support to Close Account
              </Text>
              <Ionicons name="chevron-forward" size={18} color={Colors.textMuted} />
            </TouchableOpacity>
            <View style={styles.dangerHelperWrap}>
              <Text style={styles.dangerHelper}>
                Account closure requires review by PamojaHub. All campaign and donation records are retained.
              </Text>
            </View>
          </Card>

          <View style={styles.bottomSpacer} />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Full-size logo overlay — outside the ScrollView so the Modal isn't nested
          in a scrolling subtree. Dismisses on back arrow, Android hardware back
          (Modal onRequestClose) and tap-scrim. */}
      <ImageViewer
        visible={logoViewerOpen}
        uri={church?.logoUrl}
        title={church?.name}
        onRequestClose={() => setLogoViewerOpen(false)}
      />
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.surfaceSubtle },
  flex: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xl,
  },
  wideCap: {
    maxWidth: 760,
    width: '100%',
    alignSelf: 'center',
  },

  sectionHeader: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: Spacing.lg,
    marginBottom: Spacing.sm,
    paddingHorizontal: 2,
  },

  card: { marginBottom: 0 },

  cardDivider: {
    height: 1,
    backgroundColor: Colors.borderLight,
    marginHorizontal: Spacing.md,
  },

  // Logo
  logoRow: {
    alignItems: 'center',
    marginBottom: Spacing.lg,
    gap: Spacing.sm,
  },
  logoCircle: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoInitials: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxl,
    color: Colors.primary,
  },
  changeLogoLink: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },
  changeLogoLinkDisabled: { color: Colors.textMuted },

  // Form fields
  fieldLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: 6,
    marginTop: Spacing.md,
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
  inputErrorBorder: { borderColor: Colors.danger },
  fieldError: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.danger,
    marginTop: 4,
  },

  // First-load spinner / error placeholder inside the Profile card.
  fetchStateBox: {
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
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

  // General (non-field) error block above Save.
  generalErrorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    backgroundColor: Colors.dangerLight,
    borderRadius: BorderRadius.lg,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    marginTop: Spacing.md,
  },
  generalErrorText: {
    flex: 1,
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.danger,
    lineHeight: FontSize.sm * 1.5,
  },

  // Soft background-refetch failure notice.
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
  inputMultiline: {
    height: 100,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.sm,
  },
  fieldSpacing: {
    marginBottom: 0,
  },

  saveBtn: {
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.pill,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.lg,
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.white,
  },

  // Account rows
  rowItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: 15,
    gap: Spacing.sm,
  },
  rowLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.base,
    color: Colors.text,
    flex: 1,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    flexShrink: 0,
  },
  rowValue: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    maxWidth: 160,
  },

  // Danger zone
  dangerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: 15,
    gap: Spacing.sm,
  },
  dangerRowLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.base,
    color: Colors.danger,
    flex: 1,
  },
  dangerHelperWrap: {
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.md,
  },
  dangerHelper: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    lineHeight: FontSize.xs * 1.7,
  },

  bottomSpacer: { height: Spacing.xl },
});
