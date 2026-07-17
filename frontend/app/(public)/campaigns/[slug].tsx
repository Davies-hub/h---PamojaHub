import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DonationForm from '../../../components/campaign/DonationForm';
import WhatsAppShareButton from '../../../components/campaign/WhatsAppShareButton';
import { useIsWideWeb } from '../../../components/layout/Screen';
import ProgressBar from '../../../components/ui/ProgressBar';
import RemoteImage from '../../../components/ui/RemoteImage';
import { BorderRadius, Colors, FontSize, Shadows, Spacing } from '../../../constants/theme';
import { campaignsService } from '../../../services/campaigns.service';
import { PublicCampaign } from '../../../types';
import { formatDate } from '../../../utils/formatters';

function fmtKes(n: number) {
  return `KES ${n.toLocaleString('en-KE')}`;
}

// Web-only sticky for the wide-web donate column — CSS pass-through RN types
// don't know about; harmless no-op elsewhere.
const stickyWide = Platform.OS === 'web'
  ? ({ position: 'sticky', top: Spacing.lg } as unknown as ViewStyle)
  : null;

type LoadState = 'loading' | 'error' | 'notfound' | 'ok';

export default function CampaignDetailScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const statusBarHeight = insets.top || (StatusBar.currentHeight ?? 24);
  const isWideWeb = useIsWideWeb();

  const [campaign, setCampaign] = useState<PublicCampaign | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    (async () => {
      try {
        const data = await campaignsService.getBySlug(slug);
        if (cancelled) return;
        setCampaign(data);
        setState('ok');
      } catch (err) {
        if (cancelled) return;
        // 404 = campaign gone / non-ACTIVE church → distinct not-found state.
        // Anything else (network, 5xx) → retryable error.
        if (axios.isAxiosError(err) && err.response?.status === 404) setState('notfound');
        else setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, reloadKey]);

  // BACKGROUND refresh after a successful donation — deliberately NOT reloadKey:
  // that path sets state('loading'), whose branch replaces the whole page with a
  // spinner and would UNMOUNT the DonationForm success card (receipt and all).
  // Silent swap instead: new snapshot on success, keep last-good on any failure
  // (same keep-last-good discipline as useFocusRefetch).
  const refreshCampaign = useCallback(async () => {
    try {
      const data = await campaignsService.getBySlug(slug);
      setCampaign(data);
    } catch {
      // Background only — the donor already has their success card; stale progress
      // self-corrects on the next visit.
    }
  }, [slug]);

  return (
    <View style={styles.root}>
      <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />

      {/* Back button — absolute overlay above content, present in every state */}
      <TouchableOpacity
        style={[styles.backBtn, { top: statusBarHeight + 8 }]}
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/campaigns'))}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <Ionicons name="arrow-back" size={22} color={Colors.primary} />
      </TouchableOpacity>

      {state === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : state === 'notfound' ? (
        <View style={styles.center}>
          <View style={styles.stateIconCircle}>
            <Ionicons name="search-outline" size={34} color={Colors.primary} />
          </View>
          <Text style={styles.stateTitle}>Campaign not found</Text>
          <Text style={styles.stateSub}>
            This campaign may have been removed or is no longer available.
          </Text>
        </View>
      ) : state === 'error' ? (
        <View style={styles.center}>
          <View style={styles.stateIconCircle}>
            <Ionicons name="cloud-offline-outline" size={34} color={Colors.primary} />
          </View>
          <Text style={styles.stateTitle}>Couldn’t load campaign</Text>
          <Text style={styles.stateSub}>Please check your connection and try again.</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => setReloadKey(k => k + 1)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text style={styles.retryBtnText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : campaign ? (
        (() => {
          const percent = campaign.goalAmount > 0
            ? Math.min(Math.round((campaign.raisedAmount / campaign.goalAmount) * 100), 100)
            : 0;
          const description = campaign.description.replace(/<[^>]*>/g, '').trim();
          const campaignUrl = `https://pamojahub.com/campaigns/${campaign.slug}`;
          const churchInitials =
            campaign.churchName
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map(w => w[0])
              .join('')
              .toUpperCase() || 'C';

          // ── Shared visual blocks (identical data at both widths) ────────────

          const banner = (
            <RemoteImage
              uri={campaign.bannerImageUrl}
              style={[styles.banner, isWideWeb && styles.bannerWide]}
              resizeMode="cover"
              fallback={
                <LinearGradient
                  colors={[Colors.primary, Colors.primaryDark]}
                  start={{ x: 0.15, y: 0 }}
                  end={{ x: 0.85, y: 1 }}
                  style={[styles.banner, styles.bannerFallback, isWideWeb && styles.bannerWide]}
                >
                  <View style={styles.bannerLetterCircle}>
                    <Text style={styles.bannerLetterText}>{campaign.title[0]?.toUpperCase() ?? 'P'}</Text>
                  </View>
                </LinearGradient>
              }
            />
          );

          // Organizer line — GFM-style attribution: avatar + church + provenance.
          const organizerRow = (
            <View style={styles.organizerRow}>
              <View style={styles.organizerAvatar}>
                <Text style={styles.organizerAvatarText}>{churchInitials}</Text>
              </View>
              <Text style={styles.organizerText}>
                <Text style={styles.organizerName}>{campaign.churchName}</Text>
                <Text> is fundraising on Pamoja Hub · Started {formatDate(campaign.createdAt)}</Text>
              </Text>
            </View>
          );

          // Trust badge + category chips in one quiet row.
          const badgesRow = (
            <View style={styles.badgesRow}>
              <View style={styles.trustBadge}>
                <Ionicons name="shield-checkmark" size={14} color={Colors.primaryDark} />
                <Text style={styles.trustBadgeText}>Treasurer-controlled payouts</Text>
              </View>
              <View style={[styles.chip, styles.chipAccent]}>
                <Text style={[styles.chipText, styles.chipTextAccent]}>{campaign.category}</Text>
              </View>
              {campaign.groupLabelName ? (
                <View style={styles.chip}>
                  <Text style={styles.chipText}>{campaign.groupLabelName}</Text>
                </View>
              ) : null}
            </View>
          );

          // The donate card — money header, form, share, trust line. One card,
          // both widths (sticky column on wide web).
          const donateCardContent = (
            <View>
              <View style={styles.moneyHeader}>
                <View style={styles.percentBadge}>
                  <Text style={styles.percentBadgeText}>{percent}%</Text>
                </View>
                <View style={styles.moneyTextWrap}>
                  <Text style={styles.raisedAmount} numberOfLines={1}>
                    {fmtKes(campaign.raisedAmount)}
                  </Text>
                  <Text style={styles.goalText}>
                    raised of {fmtKes(campaign.goalAmount)} goal · {campaign.donorCount}{' '}
                    {campaign.donorCount === 1 ? 'donor' : 'donors'}
                  </Text>
                </View>
              </View>
              <View style={styles.progressWrap}>
                <ProgressBar raised={campaign.raisedAmount} goal={campaign.goalAmount} height={10} showLabels={false} />
              </View>
              <View style={styles.cardDivider} />
              {/* Donate form only for ACTIVE campaigns — PAUSED/CLOSED show a notice
                  instead (the backend initiate guard rejects non-ACTIVE anyway; this
                  keeps the FE honest). Money/progress/share stay visible above. */}
              {campaign.status === 'ACTIVE' ? (
                <DonationForm
                  flat
                  campaignSlug={campaign.slug}
                  campaignTitle={campaign.title}
                  // Donor sees their own shilling land: refresh raised/progress in the
                  // background on the SUCCESS verdict only.
                  onSuccess={refreshCampaign}
                />
              ) : (
                <View style={styles.statusNotice}>
                  <Ionicons
                    name={campaign.status === 'CLOSED' ? 'lock-closed-outline' : 'pause-circle-outline'}
                    size={16}
                    color={Colors.textSecondary}
                  />
                  <Text style={styles.statusNoticeText}>
                    {campaign.status === 'CLOSED'
                      ? 'This campaign has closed. Thank you to everyone who gave.'
                      : 'This campaign is paused and not accepting donations right now.'}
                  </Text>
                </View>
              )}
              <View style={styles.shareWrap}>
                <WhatsAppShareButton campaignTitle={campaign.title} campaignUrl={campaignUrl} />
              </View>
              <View style={styles.cardTrustRow}>
                <Ionicons name="receipt-outline" size={13} color={Colors.textMuted} />
                <Text style={styles.cardTrustText}>Every donation is recorded on Pamoja Hub</Text>
              </View>
            </View>
          );

          const story = (
            <Text style={[styles.storyBody, isWideWeb && styles.storyBodyWide]}>{description}</Text>
          );

          return (
            <KeyboardAvoidingView
              style={styles.flex}
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
              <ScrollView
                style={styles.flex}
                contentContainerStyle={{ paddingBottom: (insets.bottom || 16) + Spacing.xl }}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                {isWideWeb ? (
                  // ── Wide web: story column left, sticky donate column right ──
                  <View style={styles.wideGrid}>
                    <View style={styles.wideLeft}>
                      <Text style={[styles.title, styles.titleWide]}>{campaign.title}</Text>
                      <View style={styles.bannerWrapWide}>{banner}</View>
                      {organizerRow}
                      {badgesRow}
                      <View style={styles.leftDivider} />
                      {story}
                    </View>
                    <View style={styles.wideRight}>
                      <View style={stickyWide}>
                        <View style={styles.donateCard}>{donateCardContent}</View>
                      </View>
                    </View>
                  </View>
                ) : (
                  // ── Phone: banner, sheet-lip header, donate card, story ──────
                  <View>
                    {banner}
                    <View style={styles.sheet}>
                      <Text style={styles.title}>{campaign.title}</Text>
                      {organizerRow}
                      {badgesRow}
                    </View>
                    <View style={styles.phoneSection}>
                      <View style={styles.donateCard}>{donateCardContent}</View>
                    </View>
                    <View style={styles.phoneSection}>
                      <View style={styles.leftDivider} />
                      {story}
                    </View>
                  </View>
                )}
              </ScrollView>
            </KeyboardAvoidingView>
          );
        })()
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  flex: { flex: 1 },

  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
  },
  stateIconCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  stateTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.xl,
    color: Colors.text,
    marginBottom: 6,
    textAlign: 'center',
  },
  stateSub: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: FontSize.md * 1.55,
    maxWidth: 420,
  },
  retryBtn: {
    marginTop: Spacing.lg,
    paddingHorizontal: Spacing.xl,
    height: Spacing.touch,
    borderRadius: BorderRadius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryBtnText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.white,
  },

  backBtn: {
    position: 'absolute',
    left: Spacing.md,
    zIndex: 50,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadows.md,
  },

  // Banner
  banner: {
    height: 248,
    width: '100%',
  },
  bannerWide: {
    height: 380,
  },
  bannerFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerLetterCircle: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadows.sm,
  },
  bannerLetterText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.title,
    color: Colors.primary,
  },

  // Wide grid
  wideGrid: {
    maxWidth: 1100,
    width: '100%',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: Spacing.xl + 8,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.xl,
  },
  wideLeft: {
    flex: 1.6,
    minWidth: 0,
  },
  wideRight: {
    flex: 1,
    minWidth: 320,
    maxWidth: 400,
  },
  bannerWrapWide: {
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    marginTop: Spacing.lg,
  },

  // Phone sheet — white block lipping over the banner's bottom edge
  sheet: {
    marginTop: -20,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.lg,
  },
  phoneSection: {
    paddingHorizontal: Spacing.md,
    marginTop: Spacing.lg,
  },

  // Title
  title: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxxl,
    color: Colors.text,
    lineHeight: FontSize.xxxl * 1.3,
  },
  titleWide: {
    fontSize: FontSize.titleLg,
    lineHeight: FontSize.titleLg * 1.22,
  },

  // Organizer attribution
  organizerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm + 2,
    marginTop: Spacing.md + 2,
  },
  organizerAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  organizerAvatarText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },
  organizerText: {
    flex: 1,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: FontSize.sm * 1.5,
  },
  organizerName: {
    fontFamily: 'Poppins-SemiBold',
    color: Colors.text,
  },

  // Badges
  badgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  trustBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  trustBadgeText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.xs,
    color: Colors.primaryDark,
  },
  chip: {
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.primaryDark,
  },
  chipAccent: {
    backgroundColor: Colors.accentLight,
  },
  chipTextAccent: {
    color: Colors.accentDark,
  },

  // Left column story
  leftDivider: {
    height: 1,
    backgroundColor: Colors.borderLight,
    marginVertical: Spacing.lg,
  },
  storyBody: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.text,
    lineHeight: FontSize.md * 1.75,
  },
  storyBodyWide: {
    fontSize: FontSize.base,
    lineHeight: FontSize.base * 1.75,
  },

  // Donate card
  donateCard: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    padding: Spacing.lg,
    ...Shadows.lg,
  },
  moneyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  percentBadge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.accentLight,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  percentBadgeText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.accentDark,
  },
  moneyTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  raisedAmount: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxxl,
    color: Colors.primary,
    lineHeight: FontSize.xxxl * 1.3,
  },
  goalText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    lineHeight: FontSize.sm * 1.45,
    marginTop: 1,
  },
  progressWrap: {
    marginTop: Spacing.md,
  },
  cardDivider: {
    height: 1,
    backgroundColor: Colors.borderLight,
    marginVertical: Spacing.lg,
  },
  statusNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: Colors.grey,
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
  },
  statusNoticeText: {
    flex: 1,
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  shareWrap: {
    marginTop: Spacing.md,
  },
  cardTrustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: Spacing.md,
  },
  cardTrustText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
});
