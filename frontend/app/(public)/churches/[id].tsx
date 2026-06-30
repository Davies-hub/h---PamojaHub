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
import { BorderRadius, Colors, FontSize, Spacing } from '../../../constants/theme';
import { campaignsService } from '../../../services/campaigns.service';
import { churchesService } from '../../../services/churches.service';
import { PublicCampaign, PublicChurch } from '../../../types';

type LoadState = 'loading' | 'error' | 'notfound' | 'ok';
type SectionState = 'loading' | 'error' | 'ok';

// ─── Profile header (used as ListHeaderComponent) ─────────────────────────────
// Address row REMOVED (Decision A — the public church serializer omits address).

function ProfileHeader({ church }: { church: PublicChurch }) {
  const initials = church.name
    .split(' ')
    .slice(0, 2)
    .map(w => w[0] ?? '')
    .join('')
    .toUpperCase();

  return (
    <View style={styles.profileSection}>
      <View style={styles.logoCircle}>
        <Text style={styles.logoText}>{initials}</Text>
      </View>

      <Text style={styles.churchName}>{church.name}</Text>
      <Text style={styles.denomination}>
        {church.denomination}{church.county ? ` · ${church.county}` : ''}
      </Text>

      {church.description ? (
        <Text style={styles.description}>{church.description}</Text>
      ) : null}
    </View>
  );
}

function CampaignsHeading({ count }: { count: number }) {
  return (
    <View style={styles.headingRow}>
      <Text style={styles.sectionHeading}>
        Active Campaigns{count > 0 ? ` (${count})` : ''}
      </Text>
    </View>
  );
}

function EmptyCampaigns() {
  return (
    <View style={styles.emptyCampaigns}>
      <Ionicons name="megaphone-outline" size={36} color={Colors.border} />
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
      <Ionicons name="cloud-offline-outline" size={36} color={Colors.border} />
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
      <Ionicons name="arrow-back" size={22} color={Colors.white} />
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
              <Ionicons name="business-outline" size={48} color={Colors.border} />
              <Text style={styles.stateTitle}>Church not found</Text>
              <Text style={styles.stateSub}>
                This church may not exist or is not currently active.
              </Text>
            </>
          ) : (
            <>
              <Ionicons name="cloud-offline-outline" size={48} color={Colors.border} />
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
            />
            <ProfileHeader church={church} />
            <CampaignsHeading count={church.activeCampaignCount} />
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
    height: 160,
    width: '100%',
  },

  // Profile info
  profileSection: {
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  logoCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -36,
    borderWidth: 4,
    borderColor: Colors.white,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 4,
  },
  logoText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.white,
  },
  churchName: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxl,
    color: Colors.text,
    textAlign: 'center',
    marginTop: Spacing.sm,
    lineHeight: FontSize.xxl * 1.3,
  },
  denomination: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    marginTop: 4,
    marginBottom: Spacing.sm,
  },
  description: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: FontSize.md * 1.6,
    marginBottom: Spacing.sm,
  },

  // Campaigns section
  headingRow: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  sectionHeading: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
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
    borderRadius: BorderRadius.md,
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
