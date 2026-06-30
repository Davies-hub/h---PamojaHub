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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DonationForm from '../../../components/campaign/DonationForm';
import WhatsAppShareButton from '../../../components/campaign/WhatsAppShareButton';
import ProgressBar from '../../../components/ui/ProgressBar';
import { BorderRadius, Colors, FontSize, Spacing } from '../../../constants/theme';
import { campaignsService } from '../../../services/campaigns.service';
import { PublicCampaign } from '../../../types';

function fmtKes(n: number) {
  return `KES ${n.toLocaleString('en-KE')}`;
}

type LoadState = 'loading' | 'error' | 'notfound' | 'ok';

export default function CampaignDetailScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const statusBarHeight = insets.top || (StatusBar.currentHeight ?? 24);

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
        <Ionicons name="arrow-back" size={22} color={Colors.white} />
      </TouchableOpacity>

      {state === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : state === 'notfound' ? (
        <View style={styles.center}>
          <Ionicons name="search-outline" size={48} color={Colors.border} />
          <Text style={styles.stateTitle}>Campaign not found</Text>
          <Text style={styles.stateSub}>
            This campaign may have been removed or is no longer available.
          </Text>
        </View>
      ) : state === 'error' ? (
        <View style={styles.center}>
          <Ionicons name="cloud-offline-outline" size={48} color={Colors.border} />
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
                {/* 1. Banner */}
                <LinearGradient
                  colors={[Colors.primary, Colors.primaryDark]}
                  start={{ x: 0.15, y: 0 }}
                  end={{ x: 0.85, y: 1 }}
                  style={styles.banner}
                />

                {/* 2. Campaign info */}
                <View style={styles.infoSection}>
                  <Text style={styles.breadcrumb} numberOfLines={1}>
                    {campaign.churchName}
                    {campaign.groupLabelName ? ` › ${campaign.groupLabelName}` : ''}
                  </Text>
                  <Text style={styles.title}>{campaign.title}</Text>
                  <ProgressBar raised={campaign.raisedAmount} goal={campaign.goalAmount} height={8} showLabels={false} />
                  <View style={styles.progressRow}>
                    <View style={styles.progressLeft}>
                      <Text style={styles.raisedAmount}>{fmtKes(campaign.raisedAmount)} raised</Text>
                      <Text style={styles.goalText}>
                        of {fmtKes(campaign.goalAmount)} goal · {campaign.donorCount} donors
                      </Text>
                    </View>
                    <Text style={styles.percentLabel}>{percent}%</Text>
                  </View>
                </View>

                {/* 3. Donation form */}
                <DonationForm campaignSlug={campaign.slug} campaignTitle={campaign.title} />

                {/* 4. About */}
                <View style={styles.aboutSection}>
                  <Text style={styles.aboutLabel}>About this campaign</Text>
                  <Text style={styles.aboutBody}>{description}</Text>
                </View>

                {/* 5. WhatsApp share */}
                <View style={styles.shareSection}>
                  <WhatsAppShareButton campaignTitle={campaign.title} campaignUrl={campaignUrl} />
                </View>
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
  stateTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
    marginTop: Spacing.md,
    marginBottom: 6,
    textAlign: 'center',
  },
  stateSub: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: FontSize.md * 1.5,
  },
  retryBtn: {
    marginTop: Spacing.md,
    paddingHorizontal: Spacing.lg,
    height: Spacing.touch,
    borderRadius: BorderRadius.md,
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
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  banner: {
    height: 220,
    width: '100%',
  },

  infoSection: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  breadcrumb: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginBottom: 6,
  },
  title: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxl,
    color: Colors.text,
    lineHeight: FontSize.xxl * 1.3,
    marginBottom: Spacing.md,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  progressLeft: {
    flex: 1,
    marginRight: Spacing.sm,
  },
  raisedAmount: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.primary,
  },
  goalText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    marginTop: 2,
  },
  percentLabel: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.accent,
    paddingTop: 2,
  },

  aboutSection: {
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.md,
  },
  aboutLabel: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.text,
    marginBottom: 8,
  },
  aboutBody: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.text,
    lineHeight: FontSize.md * 1.6,
  },

  shareSection: {
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.md,
  },
});
