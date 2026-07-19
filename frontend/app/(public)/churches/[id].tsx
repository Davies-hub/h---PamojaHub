import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
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
import { campaignsService } from '../../../services/campaigns.service';
import { churchesService } from '../../../services/churches.service';
import { useFocusRefetch } from '../../../hooks/useFocusRefetch';
import { usePolledFocusRefetch } from '../../../hooks/usePolledFocusRefetch';
import { PublicCampaign, PublicChurch } from '../../../types';

// Focused-poll cadence — public screens poll slower than the treasurer dashboard
// (45s): anonymous traffic is higher-volume and far less latency-sensitive than a
// treasurer watching money land. Its own named constant, per the hook's contract
// (usePolledFocusRefetch exports no default on purpose).
const PROFILE_POLL_INTERVAL_MS = 90_000;

// A 404 is NOT an error here — it is a distinct, terminal, NON-retryable outcome with
// its own copy ("may not exist" vs "check your connection"). useFocusRefetch only has
// loading/error/ok, so the fetcher RESOLVES this sentinel instead of throwing; only a
// real failure (network, 5xx) throws through to the hook's 'error'.
//
// The sentinel must be NON-NULL: useFocusRefetch.ts:48 tests `data !== null` to decide
// foreground-vs-background, so resolving `null` would pin the screen in a permanent
// first-load spinner on every run.
type ChurchResult =
  | { kind: 'ok'; church: PublicChurch }
  | { kind: 'notfound' };

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
  const numColumns = isWideWeb ? 3 : 1;

  // TWO independent hook instances — the church and its campaigns stay DELIBERATELY
  // decoupled (this was two separate effects with two separate reloadKeys). A campaigns
  // failure must NOT blank the church page: it drives only the campaigns section's own
  // error/retry, and vice versa. Both refetch on every screen FOCUS with keep-last-good
  // semantics, so a failed background refresh leaves the page as it was.
  const {
    data: churchResult,
    status: churchStatus,
    retry: retryChurch,
  } = useFocusRefetch<ChurchResult>(async () => {
    try {
      return { kind: 'ok', church: await churchesService.getById(id) };
    } catch (err) {
      // 404 (nonexistent / non-ACTIVE) → the not-found sentinel, NOT an error.
      if (axios.isAxiosError(err) && err.response?.status === 404) return { kind: 'notfound' };
      throw err;   // network / 5xx → the hook's 'error' state (retryable)
    }
  });

  // No sentinel here: the ?church=<id> filter returns this church's ACTIVE campaigns,
  // and a church with none is an empty list — [] is a legitimate result, not a 404 and
  // not an error. [] is also non-null, so it counts as data and keeps later runs in the
  // background exactly like a populated list.
  const {
    data: campaigns,
    status: campaignsStatus,
    retry: retryCampaigns,
  } = useFocusRefetch<PublicCampaign[]>(
    async () => (await campaignsService.browse({ church: id })).results,
  );

  const church = churchResult?.kind === 'ok' ? churchResult.church : null;

  // Pull-to-refresh: RefreshControl owns its own spinner; both retries run as
  // background refetches (data present), so nothing else flashes.
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([retryChurch(), retryCampaigns()]);
    } finally {
      setRefreshing(false);
    }
  }, [retryChurch, retryCampaigns]);

  // Whether each fetch currently holds data — read inside the poll tick without being
  // effect deps. Polling a section that has NO data yet would run retry() as a
  // FOREGROUND fetch and flash its spinner every tick; skip it instead (the manual
  // Try-again control owns that path).
  const hasChurchRef = useRef(false);
  hasChurchRef.current = churchResult !== null;
  const hasCampaignsRef = useRef(false);
  hasCampaignsRef.current = campaigns !== null;

  // Focused polling: armed only while the screen is FOCUSED **and** the app is
  // FOREGROUNDED — the shared hook owns that scaffolding.
  //
  // The two guards stay PER-CALL, not whole-tick: church and campaigns load
  // independently, so one may hold data while the other doesn't, and each must refresh
  // on its own merit. A whole-tick skip cannot express "refresh the church but not its
  // campaigns" — it collapses to both-or-neither (same asymmetry as the Overview
  // dashboard; see usePolledFocusRefetch.ts:15-20).
  usePolledFocusRefetch({
    intervalMs: PROFILE_POLL_INTERVAL_MS,
    label: 'church-profile-poll',
    onTick: () => {
      if (hasChurchRef.current) retryChurch();
      if (hasCampaignsRef.current) retryCampaigns();
    },
  });

  const BackButton = (
    <TouchableOpacity
      style={[styles.backBtn, { top: statusBarHeight + 8 }]}
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/churches'))}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel="Go back"
    >
      <Ionicons name="arrow-back" size={22} color={Colors.primary} />
    </TouchableOpacity>
  );

  // Whole-screen states (church-driven). Order mirrors the pre-migration ternary:
  // spinner (first load only — status is 'loading' only while there is no data),
  // then the not-found sentinel, then the retryable error.
  if (!church) {
    return (
      <View style={styles.root}>
        <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />
        {BackButton}
        <View style={styles.center}>
          {churchStatus === 'loading' ? (
            <ActivityIndicator size="large" color={Colors.primary} />
          ) : churchResult?.kind === 'notfound' ? (
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
                onPress={() => { retryChurch(); retryCampaigns(); }}
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
  // The hook's FetchStatus union is identical to the old SectionState, so this maps
  // across unchanged; the section retry drives the campaigns instance ALONE.
  const campaignsEmpty =
    campaignsStatus === 'loading' ? <CampaignsLoading /> :
    campaignsStatus === 'error' ? <CampaignsError onRetry={() => { retryCampaigns(); }} /> :
    <EmptyCampaigns />;

  return (
    <View style={styles.root}>
      <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />
      {BackButton}

      <FlatList
        data={campaigns ?? []}
        keyExtractor={item => item.id}
        numColumns={numColumns}
        key={numColumns}
        columnWrapperStyle={numColumns > 1 ? styles.gridRow : undefined}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.primary}
            colors={[Colors.primary]}
          />
        }
        renderItem={({ item }) => (
          <View style={isWideWeb ? styles.gridItem : styles.cardWrapper}>
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
              style={[styles.banner, isWideWeb && styles.bannerWide]}
            >
              <View pointerEvents="none" style={styles.bannerOrnamentA} />
              <View pointerEvents="none" style={styles.bannerOrnamentB} />
            </LinearGradient>
            <ProfileHeader church={church} />
            <View style={isWideWeb && styles.headingCapWide}>
              <CampaignsHeading count={church.activeCampaignCount} />
            </View>
          </>
        }
        ListEmptyComponent={campaignsEmpty}
        contentContainerStyle={{ paddingBottom: (insets.bottom || 16) + Spacing.xl }}
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
  bannerWide: {
    height: 224,
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

  // Wide web — masthead is full-bleed; heading + grid share the 1100 cap
  headingCapWide: {
    maxWidth: 1100,
    width: '100%',
    alignSelf: 'center',
  },
  gridRow: {
    gap: Spacing.lg,
    maxWidth: 1100,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: Spacing.md,
  },
  gridItem: {
    flex: 1,
    maxWidth: '32%',
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
