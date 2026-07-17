import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal as RNModal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useIsWideWeb } from '../../../components/layout/Screen';
import { BorderRadius, Colors, FontSize, Shadows, Spacing } from '../../../constants/theme';
import { campaignsService } from '../../../services/campaigns.service';
import { groupsService } from '../../../services/groups.service';
import { CampaignCategory } from '../../../types';

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES: CampaignCategory[] = [
  'Building', 'Outreach', 'Youth', 'Education', 'Medical', 'Relief', 'Other',
];

interface GroupOption {
  id: string | null;
  name: string;
}

// "No group / church-wide" is always the first option; the church's real labels
// are fetched live and appended (see the effect in NewCampaignScreen).
const NO_GROUP: GroupOption = { id: null, name: 'No group / Church-wide' };

// ─── Types ────────────────────────────────────────────────────────────────────

interface FormErrors {
  title?: string;
  category?: string;
  goalAmount?: string;
  description?: string;
  treasurerName?: string;
  treasurerPhone?: string;
}

// ─── Field Y-position registry for scroll-to-error ───────────────────────────

type FieldKey = keyof FormErrors;

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionCard({
  title,
  children,
  helper,
}: {
  title: string;
  children: React.ReactNode;
  helper?: string;
}) {
  return (
    <View style={styles.sectionCard}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {helper ? <Text style={styles.sectionHelper}>{helper}</Text> : null}
      <View style={styles.sectionFields}>{children}</View>
    </View>
  );
}

function FieldLabel({ label, required }: { label: string; required?: boolean }) {
  return (
    <Text style={styles.fieldLabel}>
      {label}
      {required ? <Text style={styles.required}> *</Text> : null}
    </Text>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <Text style={styles.fieldError}>{message}</Text>;
}

function UploadBox({
  icon,
  label,
  sublabel,
  dashed,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  sublabel: string;
  dashed?: boolean;
  onPress?: () => void;
}) {
  const inner = (
    <>
      <Ionicons name={icon} size={30} color={Colors.primary} />
      <Text style={styles.uploadLabel}>{label}</Text>
      <Text style={styles.uploadSublabel}>{sublabel}</Text>
    </>
  );
  if (!onPress) {
    return <View style={[styles.uploadBox, dashed && styles.uploadBoxDashed]}>{inner}</View>;
  }
  return (
    <TouchableOpacity
      style={[styles.uploadBox, dashed && styles.uploadBoxDashed]}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {inner}
    </TouchableOpacity>
  );
}

// ─── Picker modal (slide-up) ──────────────────────────────────────────────────

interface PickerModalProps<T> {
  visible: boolean;
  title: string;
  items: T[];
  selected: T;
  keyFn: (item: T) => string;
  labelFn: (item: T) => string;
  onSelect: (item: T) => void;
  onClose: () => void;
}

function PickerModal<T>({
  visible,
  title,
  items,
  selected,
  keyFn,
  labelFn,
  onSelect,
  onClose,
}: PickerModalProps<T>) {
  return (
    <RNModal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <TouchableOpacity style={styles.pickerOverlay} onPress={onClose} activeOpacity={1} />
      <View style={styles.pickerSheet}>
        <View style={styles.pickerHandle} />
        <Text style={styles.pickerTitle}>{title}</Text>
        <FlatList
          data={items}
          keyExtractor={keyFn}
          renderItem={({ item }) => {
            const isSelected = keyFn(item) === keyFn(selected);
            return (
              <TouchableOpacity
                style={styles.pickerItem}
                onPress={() => { onSelect(item); onClose(); }}
                activeOpacity={0.7}
              >
                <Text style={[styles.pickerItemText, isSelected && styles.pickerItemTextSelected]}>
                  {labelFn(item)}
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
  );
}

// ─── New Campaign screen ──────────────────────────────────────────────────────

export default function NewCampaignScreen() {
  const isWideWeb = useIsWideWeb();
  const router = useRouter();

  // ── Create state ────────────────────────────────────────────────────────
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Deferred-upload banner: picked LOCALLY here, uploaded only AFTER create succeeds.
  const [pickedBanner, setPickedBanner] =
    useState<{ uri: string; fileName?: string; mimeType?: string } | null>(null);
  const [bannerPickError, setBannerPickError] = useState<string | null>(null);
  const [uploadingBanner, setUploadingBanner] = useState(false);

  // Pick an image for the banner — LOCAL ONLY, no network. Duplicated from the
  // campaign-detail picker ([slug].tsx handleUploadBanner) minus the upload call;
  // all FE checks are UX ONLY — the backend re-validates size/format on upload.
  async function handlePickBanner() {
    setBannerPickError(null);
    // web: picker must be first await in the click handler — an intervening await
    // burns transient user activation and Chrome silently refuses the file dialog
    // (promise never settles). Permission gate is native-only (web always grants).
    if (Platform.OS !== 'web') {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setBannerPickError('Allow photo access to add a banner image.');
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
      setBannerPickError('Image is over 5 MB — choose a smaller one.');
      return;
    }
    setPickedBanner({
      uri: asset.uri,
      fileName: asset.fileName ?? undefined,
      mimeType: asset.mimeType ?? undefined,
    });
  }
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ── Group labels (fetched live from /group-labels/) ───────────────────────
  const [groupOptions, setGroupOptions] = useState<GroupOption[]>([NO_GROUP]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupsError, setGroupsError] = useState(false);

  // ── Form fields ──────────────────────────────────────────────────────────
  const [title, setTitle] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<GroupOption>(NO_GROUP);
  const [category, setCategory] = useState<CampaignCategory | ''>('');
  const [goalAmount, setGoalAmount] = useState('');
  const [description, setDescription] = useState('');
  const [treasurerName, setTreasurerName] = useState('');
  const [treasurerPhone, setTreasurerPhone] = useState('');

  // ── Pickers ──────────────────────────────────────────────────────────────
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);

  // ── Errors ───────────────────────────────────────────────────────────────
  const [errors, setErrors] = useState<FormErrors>({});

  // ── Refs for auto-scroll and focus ────────────────────────────────────────
  const scrollRef = useRef<ScrollView>(null);
  const goalRef   = useRef<TextInput>(null);
  const descRef   = useRef<TextInput>(null);
  const nameRef   = useRef<TextInput>(null);
  const phoneRef  = useRef<TextInput>(null);

  // Y-positions for each field so we can scroll to the first error
  const fieldYRef = useRef<Partial<Record<FieldKey, number>>>({});

  // ── Load the church's real group labels for the picker ─────────────────────
  // groupsService.list(false) already returns non-archived labels (server-scoped to
  // request.user.church); the extra !isArchived filter is defence-in-depth. On
  // failure we keep just the "No group" option so the form is still usable.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setGroupsLoading(true);
        setGroupsError(false);
        const labels = await groupsService.list(false);
        if (cancelled) return;
        setGroupOptions([
          NO_GROUP,
          ...labels.filter(l => !l.isArchived).map(l => ({ id: l.id, name: l.name })),
        ]);
      } catch {
        if (!cancelled) setGroupsError(true);
      } finally {
        if (!cancelled) setGroupsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────

  function clearError(field: keyof FormErrors) {
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: undefined }));
  }

  function validate(): boolean {
    const e: FormErrors = {};
    const t = title.trim();
    if (!t) e.title = 'Title is required.';
    else if (t.length > 120) e.title = 'Title must be 120 characters or fewer.';
    if (!category) e.category = 'Please select a category.';
    const goal = goalAmount.trim();
    if (!goal) e.goalAmount = 'Goal amount is required.';
    else if (isNaN(Number(goal)) || Number(goal) <= 0) e.goalAmount = 'Enter a valid amount greater than 0.';
    if (!description.trim()) e.description = 'Description is required.';
    if (!treasurerName.trim()) e.treasurerName = 'Treasurer name is required.';
    const phone = treasurerPhone.trim();
    if (!phone) e.treasurerPhone = 'Treasurer phone is required.';
    else if (!/^(07|01)\d{8}$/.test(phone)) e.treasurerPhone = 'Enter a valid Safaricom number (e.g. 0712 345678).';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function scrollToFirstError(errs: FormErrors) {
    const ORDER: FieldKey[] = ['title', 'goalAmount', 'description', 'category', 'treasurerName', 'treasurerPhone'];
    for (const key of ORDER) {
      if (errs[key]) {
        const y = fieldYRef.current[key];
        if (y !== undefined) {
          scrollRef.current?.scrollTo({ y: Math.max(0, y - 16), animated: true });
        }
        break;
      }
    }
  }

  function handleCreateError(err: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (err as any)?.response?.data;
    const pickFirst = (v: unknown): string | undefined =>
      Array.isArray(v) ? String(v[0]) : typeof v === 'string' ? v : undefined;

    if (data && typeof data === 'object') {
      // DRF field-errors → map each snake_case key back to its form field.
      const fe: FormErrors = {};
      const t  = pickFirst(data.title);            if (t)  fe.title = t;
      const g  = pickFirst(data.goal_amount);      if (g)  fe.goalAmount = g;
      const d  = pickFirst(data.description);      if (d)  fe.description = d;
      const c  = pickFirst(data.category);         if (c)  fe.category = c;
      const tn = pickFirst(data.treasurer_name);   if (tn) fe.treasurerName = tn;
      const tp = pickFirst(data.treasurer_phone);  if (tp) fe.treasurerPhone = tp;

      if (Object.keys(fe).length > 0) {
        setErrors(prev => ({ ...prev, ...fe }));
        scrollToFirstError(fe);
        return;
      }
      // {detail} — FREE-tier cap, cross-church group label, or another guard.
      const detail = pickFirst(data.detail);
      if (detail) { setSubmitError(detail); return; }
    }
    setSubmitError('Could not create the campaign. Please check your connection and try again.');
  }

  async function handleSubmit() {
    const e: FormErrors = {};
    const t = title.trim();
    if (!t) e.title = 'Title is required.';
    else if (t.length > 120) e.title = 'Title must be 120 characters or fewer.';
    if (!category) e.category = 'Please select a category.';
    const goal = goalAmount.trim();
    if (!goal) e.goalAmount = 'Goal amount is required.';
    else if (isNaN(Number(goal)) || Number(goal) <= 0) e.goalAmount = 'Enter a valid amount greater than 0.';
    if (!description.trim()) e.description = 'Description is required.';
    if (!treasurerName.trim()) e.treasurerName = 'Treasurer name is required.';
    const phone = treasurerPhone.trim();
    if (!phone) e.treasurerPhone = 'Treasurer phone is required.';
    else if (!/^(07|01)\d{8}$/.test(phone)) e.treasurerPhone = 'Enter a valid Safaricom number (e.g. 0712 345678).';

    if (Object.keys(e).length > 0) {
      setErrors(e);
      scrollToFirstError(e);
      return;
    }

    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const created = await campaignsService.create({
        title: title.trim(),
        description: description.trim(),
        goalAmount: goalAmount.trim(),
        category,
        treasurerName: treasurerName.trim(),
        treasurerPhone: treasurerPhone.trim(),
        groupLabelId: selectedGroup.id,   // null → omitted by the service
        // banner is NOT part of create — it is uploaded to the banner endpoint below.
      });

      // From here on the create HAS SUCCEEDED and must NEVER look failed — showing
      // an error on the form now would invite a retry that DUPLICATE-CREATES the
      // campaign. A banner-upload failure is carried to the detail screen instead.
      let bannerFailed = false;
      if (pickedBanner) {
        setUploadingBanner(true);
        try {
          await campaignsService.uploadBanner(created.slug, pickedBanner);
        } catch (e) {
          // Deliberate swallow (anti-duplicate-create — see comment above), but the
          // failure must never be invisible in the console again (2026-07-17 bug).
          console.warn('banner upload failed after create; carried to detail screen:', e);
          bannerFailed = true;   // non-blocking: the detail banner block is the retry path
        }
      }

      // Navigate to the REAL created campaign by its SERVER-allocated slug (not a
      // lowercased-title guess). replace() so Back doesn't return to the form.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      router.replace(
        `/(treasurer)/campaigns/${created.slug}${bannerFailed ? '?bannerFailed=1' : ''}` as any,
      );
    } catch (err) {
      // CREATE failed (nothing was made) — surface server 400s (field-errors AND
      // {detail}); stay on the form.
      handleCreateError(err);
      setIsSubmitting(false);
      setUploadingBanner(false);
    }
  }

  // ── Form screen ───────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, isWideWeb && styles.wideCap]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Back link */}
        <TouchableOpacity
          style={styles.backLink}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(treasurer)/campaigns' as any))}
          accessibilityRole="button"
          accessibilityLabel="Back to Campaigns"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={18} color={Colors.primary} />
          <Text style={styles.backLinkText}>Back to Campaigns</Text>
        </TouchableOpacity>

        {/* ── Section: Campaign Details ── */}
        <SectionCard title="Campaign Details">
          {/* Title */}
          <View
            style={styles.fieldGroup}
            onLayout={e => { fieldYRef.current.title = e.nativeEvent.layout.y; }}
          >
            <FieldLabel label="Campaign Title" required />
            <TextInput
              style={[styles.textInput, errors.title && styles.inputError]}
              value={title}
              onChangeText={t => { setTitle(t); clearError('title'); }}
              placeholder="e.g. District 5 Classroom Desks Fund"
              placeholderTextColor={Colors.textMuted}
              maxLength={120}
              returnKeyType="next"
              onSubmitEditing={() => goalRef.current?.focus()}
              blurOnSubmit={false}
              accessibilityLabel="Campaign title"
            />
            <View style={styles.titleFooter}>
              <FieldError message={errors.title} />
              <Text style={[styles.charCounter, title.length > 110 && styles.charCounterWarn]}>
                {title.length}/120
              </Text>
            </View>
          </View>

          {/* Goal Amount — auto-advance from title */}
          <View
            style={styles.fieldGroup}
            onLayout={e => { fieldYRef.current.goalAmount = e.nativeEvent.layout.y; }}
          >
            <FieldLabel label="Fundraising Goal (KES)" required />
            <TextInput
              ref={goalRef}
              style={[styles.textInput, errors.goalAmount && styles.inputError]}
              value={goalAmount}
              onChangeText={t => { setGoalAmount(t); clearError('goalAmount'); }}
              placeholder="e.g. 150000"
              placeholderTextColor={Colors.textMuted}
              keyboardType="decimal-pad"
              returnKeyType="next"
              onSubmitEditing={() => descRef.current?.focus()}
              blurOnSubmit={false}
              accessibilityLabel="Fundraising goal in KES"
            />
            <FieldError message={errors.goalAmount} />
          </View>

          {/* Description — multiline, no auto-advance on return */}
          <View
            style={styles.fieldGroup}
            onLayout={e => { fieldYRef.current.description = e.nativeEvent.layout.y; }}
          >
            <FieldLabel label="Description" required />
            <TextInput
              ref={descRef}
              style={[styles.textInput, styles.textArea, errors.description && styles.inputError]}
              value={description}
              onChangeText={t => { setDescription(t); clearError('description'); }}
              placeholder="Describe the campaign purpose, how funds will be used, and the expected impact on your community…"
              placeholderTextColor={Colors.textMuted}
              multiline
              numberOfLines={6}
              textAlignVertical="top"
              accessibilityLabel="Campaign description"
            />
            <FieldError message={errors.description} />
          </View>

          {/* Category — dropdown, skip in auto-focus chain */}
          <View
            style={styles.fieldGroup}
            onLayout={e => { fieldYRef.current.category = e.nativeEvent.layout.y; }}
          >
            <FieldLabel label="Category" required />
            <TouchableOpacity
              style={[styles.pickerField, errors.category && styles.inputError]}
              onPress={() => { setShowCategoryPicker(true); clearError('category'); }}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Select category"
            >
              <Text style={[styles.pickerFieldText, !category && styles.pickerPlaceholder]}>
                {category || 'Select a category…'}
              </Text>
              <Ionicons name="chevron-down" size={18} color={Colors.textMuted} />
            </TouchableOpacity>
            <FieldError message={errors.category} />
          </View>

          {/* Group Label — dropdown (live labels), skip in auto-focus chain */}
          <View style={styles.fieldGroup}>
            <FieldLabel label="Group Label" />
            <TouchableOpacity
              style={styles.pickerField}
              onPress={() => setShowGroupPicker(true)}
              activeOpacity={0.7}
              disabled={groupsLoading}
              accessibilityRole="button"
              accessibilityLabel="Select group label"
            >
              {groupsLoading ? (
                <Text style={[styles.pickerFieldText, styles.pickerPlaceholder]}>Loading groups…</Text>
              ) : (
                <Text style={styles.pickerFieldText}>{selectedGroup.name}</Text>
              )}
              {groupsLoading ? (
                <ActivityIndicator size="small" color={Colors.primary} />
              ) : (
                <Ionicons name="chevron-down" size={18} color={Colors.textMuted} />
              )}
            </TouchableOpacity>
            {groupsError ? (
              <Text style={styles.groupsErrorNote}>
                Couldn&apos;t load your groups — you can still create a church-wide campaign.
              </Text>
            ) : null}
          </View>
        </SectionCard>

        {/* ── Section: Media — banner picked LOCALLY here, uploaded after create ── */}
        <SectionCard
          title="Media (optional)"
          helper="Optional — you can also add or change the banner later from the campaign page."
        >
          {pickedBanner ? (
            <View style={styles.bannerPreviewWrap}>
              <Image
                source={{ uri: pickedBanner.uri }}
                style={styles.bannerPreview}
                resizeMode="cover"
              />
              <View style={styles.bannerPreviewMeta}>
                <Text style={styles.bannerPreviewName} numberOfLines={1}>
                  {pickedBanner.fileName ?? 'banner.jpg'}
                </Text>
                <TouchableOpacity
                  onPress={() => setPickedBanner(null)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel="Remove banner image"
                >
                  <Text style={styles.bannerRemoveText}>Remove</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <UploadBox
              icon="image-outline"
              label="Add banner image"
              sublabel="JPG or PNG · Recommended 1200 × 630 px · Max 5 MB"
              dashed
              onPress={handlePickBanner}
            />
          )}
          {bannerPickError ? (
            <Text style={styles.fieldError}>{bannerPickError}</Text>
          ) : null}
        </SectionCard>

        {/* ── Section: Campaign Treasurer ── */}
        <SectionCard
          title="Campaign Treasurer"
          helper="This number will receive payouts AND is used to access campaign reports via the Treasurer Portal."
        >
          {/* Treasurer Name */}
          <View
            style={styles.fieldGroup}
            onLayout={e => { fieldYRef.current.treasurerName = e.nativeEvent.layout.y; }}
          >
            <FieldLabel label="Treasurer Name" required />
            <TextInput
              ref={nameRef}
              style={[styles.textInput, errors.treasurerName && styles.inputError]}
              value={treasurerName}
              onChangeText={t => { setTreasurerName(t); clearError('treasurerName'); }}
              placeholder="Full name"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="words"
              returnKeyType="next"
              onSubmitEditing={() => phoneRef.current?.focus()}
              blurOnSubmit={false}
              accessibilityLabel="Treasurer full name"
            />
            <FieldError message={errors.treasurerName} />
          </View>

          {/* Treasurer Phone */}
          <View
            style={styles.fieldGroup}
            onLayout={e => { fieldYRef.current.treasurerPhone = e.nativeEvent.layout.y; }}
          >
            <FieldLabel label="Treasurer M-Pesa Phone" required />
            <TextInput
              ref={phoneRef}
              style={[styles.textInput, errors.treasurerPhone && styles.inputError]}
              value={treasurerPhone}
              onChangeText={t => { setTreasurerPhone(t); clearError('treasurerPhone'); }}
              placeholder="07XX XXX XXX"
              placeholderTextColor={Colors.textMuted}
              keyboardType="phone-pad"
              maxLength={10}
              returnKeyType="done"
              accessibilityLabel="Treasurer M-Pesa phone number"
            />
            <FieldError message={errors.treasurerPhone} />
          </View>
        </SectionCard>

        {/* ── General server-error surface (FREE-tier cap, cross-church label, network) ── */}
        {submitError ? (
          <View style={styles.submitErrorBanner} accessibilityLiveRegion="polite">
            <Ionicons name="alert-circle" size={18} color={Colors.danger} />
            <Text style={styles.submitErrorText}>{submitError}</Text>
          </View>
        ) : null}

        {/* ── Save button ── */}
        <TouchableOpacity
          style={[styles.saveBtn, isSubmitting && styles.saveBtnDisabled]}
          onPress={handleSubmit}
          disabled={isSubmitting}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Save campaign"
        >
          {isSubmitting ? (
            <Text style={styles.saveBtnText}>
              {uploadingBanner ? 'Uploading banner…' : 'Creating campaign…'}
            </Text>
          ) : (
            <Text style={styles.saveBtnText}>Save Campaign</Text>
          )}
        </TouchableOpacity>
      </ScrollView>

      {/* ── Group picker modal ── */}
      <PickerModal
        visible={showGroupPicker}
        title="Select Group Label"
        items={groupOptions}
        selected={selectedGroup}
        keyFn={item => item.id ?? 'none'}
        labelFn={item => item.name}
        onSelect={setSelectedGroup}
        onClose={() => setShowGroupPicker(false)}
      />

      {/* ── Category picker modal ── */}
      <PickerModal
        visible={showCategoryPicker}
        title="Select Category"
        items={CATEGORIES}
        selected={category as CampaignCategory}
        keyFn={item => item}
        labelFn={item => item}
        onSelect={cat => setCategory(cat)}
        onClose={() => setShowCategoryPicker(false)}
      />
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.surfaceSubtle,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: Spacing.md,
    gap: Spacing.md,
    paddingBottom: Spacing.xxl,
  },
  wideCap: {
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },

  // Back link
  backLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  backLinkText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.md,
    color: Colors.primary,
  },

  // Section card
  sectionCard: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    padding: Spacing.md,
    ...Shadows.sm,
  },
  sectionTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
    marginBottom: 4,
  },
  sectionHelper: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 19,
    marginBottom: Spacing.sm,
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.lg,
    padding: Spacing.sm + 2,
  },
  sectionFields: {
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },

  // Field group
  fieldGroup: {
    gap: 4,
  },
  fieldLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  required: {
    color: Colors.danger,
  },
  fieldError: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.danger,
  },

  // Text inputs
  textInput: {
    height: 50,
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: BorderRadius.lg,
    paddingHorizontal: Spacing.md,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.text,
    backgroundColor: Colors.white,
  },
  textArea: {
    height: 130,
    paddingTop: 12,
    paddingBottom: 12,
  },
  inputError: {
    borderColor: Colors.danger,
  },

  // Title footer (char counter + error side by side)
  titleFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  charCounter: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textAlign: 'right',
    flexShrink: 0,
  },
  charCounterWarn: {
    color: Colors.warning,
  },

  // Picker field (looks like a TextInput)
  pickerField: {
    height: 50,
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: BorderRadius.lg,
    paddingHorizontal: Spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.white,
  },
  pickerFieldText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.text,
    flex: 1,
  },
  pickerPlaceholder: {
    color: Colors.textMuted,
  },
  groupsErrorNote: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },

  // Upload box
  uploadBox: {
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: BorderRadius.xl,
    paddingVertical: Spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surfaceSubtle,
    gap: 6,
  },
  uploadBoxDashed: {
    borderStyle: 'dashed',
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryLight + '55',
  },
  uploadLabel: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.primary,
  },
  uploadSublabel: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: Spacing.lg,
  },

  fieldSpacer: {
    height: Spacing.xs,
  },

  // Picked-banner local preview (no upload yet)
  bannerPreviewWrap: {
    gap: Spacing.sm,
  },
  bannerPreview: {
    width: '100%',
    aspectRatio: 1200 / 630,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.grey,
  },
  bannerPreviewMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  bannerPreviewName: {
    flex: 1,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  bannerRemoveText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.danger,
  },

  // Save button
  saveBtn: {
    height: 52,
    backgroundColor: Colors.accent,
    borderRadius: BorderRadius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.sm,
  },
  saveBtnDisabled: {
    opacity: 0.6,
  },
  saveBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.white,
  },

  // General server-error banner
  submitErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.dangerLight,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.danger,
    padding: Spacing.sm + 2,
  },
  submitErrorText: {
    flex: 1,
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.danger,
    lineHeight: 19,
  },

  // Picker modal (slide-up sheet)
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
    maxHeight: '60%',
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
    backgroundColor: Colors.borderLight,
    marginHorizontal: Spacing.md,
  },
});
