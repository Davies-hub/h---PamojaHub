import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import CampaignCard from '../../../components/campaign/CampaignCard';
import { useIsWideWeb } from '../../../components/layout/Screen';
import RemoteImage from '../../../components/ui/RemoteImage';
import { BorderRadius, Colors, FontSize, Shadows, Spacing } from '../../../constants/theme';

const CONTENT_CAP = 760;
import { campaignsService } from '../../../services/campaigns.service';
import { churchesService } from '../../../services/churches.service';
import { PublicCampaign, PublicChurch } from '../../../types';

type LoadState = 'loading' | 'error' | 'notfound' | 'ok';
type SectionState = 'loading' | 'error' | 'ok';

// ─── Profile header (used as ListHeaderComponent) ─────────────────────────────
// Address row REMOVED (Decision A — the public church serializer omits address).

function ProfileHeader({ church }: { church: PublicChurch }) {
  const isWideWeb = useIsWideWeb();
  const initials = church.name
    .split(' ')
    .slice(0, 2)
    .map(w => w[0] ?? '')
    .join('')
    .toUpperCase();

  return (
    <View style={styles.profileSection}>
      <RemoteImage
        uri={church.logoUrl}
        style={styles.logoCircle}
        resizeMode="cover"
        fallback={
          <View style={[styles.logoCircle, styles.logoFallback]}>
            <Text style={styles.logoText}>{initials}</Text>
          </View>
        }
      />

      <Text style={[styles.churchName, isWideWeb && styles.churchNameWide]}>{church.name}</Text>
      <View style={styles.metaRow}>
        <Ionicons name="business-outline" size={13} color={Colors.textMuted} />
        <Text style={styles.denomination}>
          {church.denomination}{church.county ? ` · ${church.county}` : ''}
        </Text>
      </View>

      {church.description ? (
        <Text style={styles.description}>{church.description}</Text>
      ) : null}
    </View>
  );
}

function CampaignsHeading({ count }: { count: number }) {
  return (
    <View style={styles.headingRow}>
      <Text style={styles.sectionHeading}>Active Campaigns</Text>
      {count > 0 ? (
        <View style={styles.countPill}>
          <Text style={styles.countPillText}>{count}</Text>
        </View>
      ) : null}
    </View>
  );
}

function EmptyCampaigns() {
  return (
    <View style={styles.emptyCampaigns}>
      <View style={styles.emptyIconCircle}>
        <Ionicons name="megaphone-outline" size={26} color={Colors.primary} />
      </View>
      <Text style={styles.emptyText}>No active campaigns right now</Text>
    </View>
  );
}

function CampaignsLoading() {
  return (
    <View style={styles.emptyCampaigns}>
      <ActivityIndicator size="small" color={Colors.primary} />
    </View>
  );
}

function CampaignsError({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.emptyCampaigns}>
      <View style={styles.emptyIconCircle}>
        <Ionicons name="cloud-offline-outline" size={26} color={Colors.primary} />
      </View>
      <Text style={styles.emptyText}>Couldn’t load campaigns.</Text>
      <TouchableOpacity
        style={styles.sectionRetryBtn}
        onPress={onRetry}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="Retry campaigns"
      >
        <Text style={styles.sectionRetryText}>Try again</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function ChurchProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const statusBarHeight = insets.top || (StatusBar.currentHeight ?? 24);
  const isWideWeb = useIsWideWeb();

  const [church, setChurch] = useState<PublicChurch | null>(null);
  const [churchState, setChurchState] = useState<LoadState>('loading');
  const [churchReloadKey, setChurchReloadKey] = useState(0);

  const [campaigns, setCampaigns] = useState<PublicCampaign[]>([]);
  const [campaignsState, setCampaignsState] = useState<SectionState>('loading');
  const [campaignsReloadKey, setCampaignsReloadKey] = useState(0);

  // Church load — independent. A 404 (nonexistent/non-ACTIVE) → whole-screen
  // not-found; any other failure → whole-screen retryable error.
  useEffect(() => {
    let cancelled = false;
    setChurchState('loading');
    (async () => {
      try {
        const data = await churchesService.getById(id);
        if (cancelled) return;
        setChurch(data);
        setChurchState('ok');
      } catch (err) {
        if (cancelled) return;
        if (axios.isAxiosError(err) && err.response?.status === 404) setChurchState('notfound');
        else setChurchState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, churchReloadKey]);

  // Campaigns load — INDEPENDENT of the church load. The backend ?church=<id>
  // filter returns this church's ACTIVE campaigns (paginated); a church with none
  // → empty results (not an error). A failure here must NOT blank the church page —
  // it only drives the campaigns section's own error/retry.
  useEffect(() => {
    let cancelled = false;
    setCampaignsState('loading');
    (async () => {
      try {
        const res = await campaignsService.browse({ church: id });
        if (cancelled) return;
        setCampaigns(res.results);
        setCampaignsState('ok');
      } catch {
        if (cancelled) return;
        setCampaignsState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, campaignsReloadKey]);

  const BackButton = (
    <TouchableOpacity
      style={[styles.backBtn, { top: statusBarHeight + 8 }]}
      onPress={() => router.back()}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel="Go back"
    >
      <Ionicons name="arrow-back" size={22} color={Colors.primary} />
    </TouchableOpacity>
  );

  // Whole-screen states (church-driven).
  if (churchState !== 'ok' || !church) {
    return (
      <View style={styles.root}>
        <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />
        {BackButton}
        <View style={styles.center}>
          {churchState === 'loading' ? (
            <ActivityIndicator size="large" color={Colors.primary} />
          ) : churchState === 'notfound' ? (
            <>
              <View style={styles.stateIconCircle}>
                <Ionicons name="business-outline" size={34} color={Colors.primary} />
              </View>
              <Text style={styles.stateTitle}>Church not found</Text>
              <Text style={styles.stateSub}>
                This church may not exist or is not currently active.
              </Text>
            </>
          ) : (
            <>
              <View style={styles.stateIconCircle}>
                <Ionicons name="cloud-offline-outline" size={34} color={Colors.primary} />
              </View>
              <Text style={styles.stateTitle}>Couldn’t load church</Text>
              <Text style={styles.stateSub}>Please check your connection and try again.</Text>
              <TouchableOpacity
                style={styles.retryBtn}
                onPress={() => { setChurchReloadKey(k => k + 1); setCampaignsReloadKey(k => k + 1); }}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Try again"
              >
                <Text style={styles.retryBtnText}>Try again</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    );
  }

  // Church loaded OK — render profile + the campaigns section (own loading/error/empty).
  const campaignsEmpty =
    campaignsState === 'loading' ? <CampaignsLoading /> :
    campaignsState === 'error' ? <CampaignsError onRetry={() => setCampaignsReloadKey(k => k + 1)} /> :
    <EmptyCampaigns />;

  return (
    <View style={styles.root}>
      <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />
      {BackButton}

      <FlatList
        data={campaigns}
        keyExtractor={item => item.id}
        renderItem={({ item }) => (
          <View style={styles.cardWrapper}>
            <CampaignCard
              campaign={item}
              onDonate={() => router.push(`/campaigns/${item.slug}` as any)}
            />
          </View>
        )}
        ListHeaderComponent={
          <>
            <LinearGradient
              colors={[Colors.primary, Colors.primaryDark]}
              start={{ x: 0.15, y: 0 }}
              end={{ x: 0.85, y: 1 }}
              style={styles.banner}
            >
              <View pointerEvents="none" style={styles.bannerOrnamentA} />
              <View pointerEvents="none" style={styles.bannerOrnamentB} />
            </LinearGradient>
            <ProfileHeader church={church} />
            <CampaignsHeading count={church.activeCampaignCount} />
          </>
        }
        ListEmptyComponent={campaignsEmpty}
        contentContainerStyle={[
          { paddingBottom: (insets.bottom || 16) + Spacing.xl },
          isWideWeb && styles.wideContent,
        ]}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },

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

  banner: {
    height: 176,
    width: '100%',
    overflow: 'hidden',
  },
  bannerOrnamentA: {
    position: 'absolute',
    top: -70,
    right: -50,
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  bannerOrnamentB: {
    position: 'absolute',
    bottom: -80,
    left: -60,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },

  wideContent: {
    maxWidth: CONTENT_CAP,
    width: '100%',
    alignSelf: 'center',
  },

  // Profile info
  profileSection: {
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  logoCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    marginTop: -42,
    borderWidth: 4,
    borderColor: Colors.white,
    ...Shadows.md,
  },
  logoFallback: {
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxl,
    color: Colors.primary,
  },
  churchName: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxl,
    color: Colors.text,
    textAlign: 'center',
    marginTop: Spacing.sm + 2,
    lineHeight: FontSize.xxl * 1.3,
    maxWidth: 560,
  },
  churchNameWide: {
    fontSize: FontSize.title,
    lineHeight: FontSize.title * 1.25,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 4,
    marginBottom: Spacing.sm,
  },
  denomination: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  description: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: FontSize.md * 1.65,
    marginBottom: Spacing.sm,
    maxWidth: 560,
  },

  // Campaigns section
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.sm + 2,
  },
  sectionHeading: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
  },
  countPill: {
    minWidth: 26,
    height: 24,
    paddingHorizontal: 8,
    borderRadius: BorderRadius.pill,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countPillText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.xs,
    color: Colors.primaryDark,
  },
  cardWrapper: {
    paddingHorizontal: Spacing.md,
  },
  emptyCampaigns: {
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: Spacing.lg,
    gap: Spacing.sm,
  },
  emptyIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  sectionRetryBtn: {
    marginTop: 4,
    paddingHorizontal: Spacing.lg,
    height: 40,
    borderRadius: BorderRadius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionRetryText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.white,
  },
});
