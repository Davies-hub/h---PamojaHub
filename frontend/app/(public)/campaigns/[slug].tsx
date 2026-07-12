import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
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

  return (
    <View style={styles.root}>
      <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />

      {/* Back button — absolute overlay above content, present in every state */}
      <TouchableOpacity
        style={[styles.backBtn, { top: statusBarHeight + 8 }]}
        onPress={() => router.back()}
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

          const titleBlock = (
            <View>
              <Text style={[styles.title, isWideWeb && styles.titleWide]}>{campaign.title}</Text>
              <View style={styles.chipsRow}>
                <View style={[styles.chip, styles.chipAccent]}>
                  <Text style={[styles.chipText, styles.chipTextAccent]}>{campaign.category}</Text>
                </View>
                {campaign.groupLabelName ? (
                  <View style={styles.chip}>
                    <Text style={styles.chipText}>{campaign.groupLabelName}</Text>
                  </View>
                ) : null}
              </View>
              <View style={styles.churchCard}>
                <View style={styles.churchAvatar}>
                  <Text style={styles.churchAvatarText}>{churchInitials}</Text>
                </View>
                <View style={styles.churchTextWrap}>
                  <Text style={styles.churchName} numberOfLines={1}>{campaign.churchName}</Text>
                  <Text style={styles.churchCaption}>
                    Church on Pamoja Hub · Started {formatDate(campaign.createdAt)}
                  </Text>
                </View>
              </View>
            </View>
          );

          const statsBlock = (
            <View>
              <Text style={styles.raisedAmount}>{fmtKes(campaign.raisedAmount)}</Text>
              <Text style={styles.goalText}>raised of {fmtKes(campaign.goalAmount)} goal</Text>
              <ProgressBar raised={campaign.raisedAmount} goal={campaign.goalAmount} height={8} showLabels={false} />
              <View style={styles.statMetaRow}>
                <View style={styles.percentPill}>
                  <Text style={styles.percentPillText}>{percent}% funded</Text>
                </View>
                <View style={styles.donorMeta}>
                  <Ionicons name="people-outline" size={15} color={Colors.textSecondary} />
                  <Text style={styles.donorMetaText}>
                    {campaign.donorCount} {campaign.donorCount === 1 ? 'donor' : 'donors'}
                  </Text>
                </View>
              </View>
            </View>
          );

          const trustStrip = (
            <View style={styles.trustStrip}>
              <View style={styles.trustRow}>
                <View style={styles.trustIcon}>
                  <Ionicons name="shield-checkmark-outline" size={16} color={Colors.primary} />
                </View>
                <View style={styles.trustTextWrap}>
                  <Text style={styles.trustRowTitle}>Treasurer-controlled</Text>
                  <Text style={styles.trustRowCaption}>
                    Payouts require the church treasurer’s approval.
                  </Text>
                </View>
              </View>
              <View style={styles.trustRowDivider} />
              <View style={styles.trustRow}>
                <View style={styles.trustIcon}>
                  <Ionicons name="receipt-outline" size={16} color={Colors.primary} />
                </View>
                <View style={styles.trustTextWrap}>
                  <Text style={styles.trustRowTitle}>On the record</Text>
                  <Text style={styles.trustRowCaption}>
                    Every donation is recorded on Pamoja Hub.
                  </Text>
                </View>
              </View>
            </View>
          );

          const aboutBlock = (
            <View style={isWideWeb && styles.aboutWide}>
              <Text style={styles.aboutLabel}>ABOUT THIS CAMPAIGN</Text>
              <Text style={[styles.aboutBody, isWideWeb && styles.aboutBodyWide]}>{description}</Text>
            </View>
          );

          const shareBlock = (
            <View style={isWideWeb && styles.shareWide}>
              <WhatsAppShareButton campaignTitle={campaign.title} campaignUrl={campaignUrl} />
            </View>
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
                  // ── Wide web: content left, donate column right ──────────────
                  <View style={styles.wideGrid}>
                    <View style={styles.wideLeft}>
                      <View style={styles.bannerWrapWide}>{banner}</View>
                      {titleBlock}
                      {aboutBlock}
                      {shareBlock}
                    </View>
                    <View style={styles.wideRight}>
                      <View style={stickyWide}>
                        <View style={styles.rightCard}>
                          {statsBlock}
                          <View style={styles.rightDivider} />
                          <DonationForm flat campaignSlug={campaign.slug} campaignTitle={campaign.title} />
                        </View>
                        {trustStrip}
                      </View>
                    </View>
                  </View>
                ) : (
                  // ── Phone: banner, sheet-lip info block, donate right after ──
                  <View>
                    {banner}
                    <View style={styles.sheet}>
                      {titleBlock}
                      <View style={styles.sheetStats}>{statsBlock}</View>
                    </View>
                    <View style={styles.phoneSection}>
                      <DonationForm campaignSlug={campaign.slug} campaignTitle={campaign.title} />
                    </View>
                    <View style={styles.phoneSection}>{trustStrip}</View>
                    <View style={styles.phoneSection}>{aboutBlock}</View>
                    <View style={styles.phoneSection}>{shareBlock}</View>
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
    height: 360,
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
    gap: Spacing.xl,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.lg,
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
    marginBottom: Spacing.lg,
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
  sheetStats: {
    marginTop: Spacing.lg,
  },
  phoneSection: {
    paddingHorizontal: Spacing.md,
    marginTop: Spacing.lg,
  },

  // Title / chips / church
  title: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxxl,
    color: Colors.text,
    lineHeight: FontSize.xxxl * 1.3,
  },
  titleWide: {
    fontSize: FontSize.title,
    lineHeight: FontSize.title * 1.25,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginTop: Spacing.sm + 2,
  },
  chip: {
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 12,
    paddingVertical: 4,
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
  churchCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm + 4,
    backgroundColor: Colors.surfaceSubtle,
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    marginTop: Spacing.md,
  },
  churchAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  churchAvatarText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.primary,
  },
  churchTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  churchName: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.base,
    color: Colors.text,
    lineHeight: 22,
  },
  churchCaption: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 1,
  },

  // Stats
  raisedAmount: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxl + 2,
    color: Colors.primary,
    lineHeight: (FontSize.xxl + 2) * 1.3,
  },
  goalText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    marginBottom: Spacing.sm + 2,
  },
  statMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.sm + 2,
  },
  percentPill: {
    backgroundColor: Colors.accentLight,
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  percentPillText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.xs,
    color: Colors.accentDark,
  },
  donorMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  donorMetaText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },

  // Right column (wide)
  rightCard: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    padding: Spacing.lg,
    ...Shadows.lg,
  },
  rightDivider: {
    height: 1,
    backgroundColor: Colors.borderLight,
    marginVertical: Spacing.lg,
  },

  // Trust strip
  trustStrip: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    padding: Spacing.md,
    marginTop: Spacing.md,
    ...Shadows.sm,
  },
  trustRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm + 2,
  },
  trustIcon: {
    width: 32,
    height: 32,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  trustTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  trustRowTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.text,
    lineHeight: 19,
  },
  trustRowCaption: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    lineHeight: 17,
    marginTop: 1,
  },
  trustRowDivider: {
    height: 1,
    backgroundColor: Colors.borderLight,
    marginVertical: Spacing.sm + 2,
    marginLeft: 32 + Spacing.sm + 2,
  },

  // About
  aboutWide: {
    marginTop: Spacing.xl,
  },
  aboutLabel: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.xs,
    letterSpacing: 1.3,
    color: Colors.textMuted,
    marginBottom: Spacing.sm + 2,
  },
  aboutBody: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.text,
    lineHeight: FontSize.md * 1.7,
  },
  aboutBodyWide: {
    fontSize: FontSize.base,
    lineHeight: FontSize.base * 1.7,
  },

  // Share
  shareWide: {
    marginTop: Spacing.lg,
    maxWidth: 320,
  },
});
