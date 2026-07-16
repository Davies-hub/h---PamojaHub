import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useIsWideWeb } from '../../../components/layout/Screen';
import ProgressBar from '../../../components/ui/ProgressBar';
import ResponsiveSheet from '../../../components/ui/ResponsiveSheet';
import { BorderRadius, Colors, FontSize, Shadows, Spacing } from '../../../constants/theme';
import { campaignsService } from '../../../services/campaigns.service';
import { CampaignStatus, TreasurerCampaign } from '../../../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtKes(n: number): string {
  return `KES ${n.toLocaleString('en-KE')}`;
}

// Pull the DRF error `detail` off an axios error, if present. Returns undefined for a
// bare network failure — the caller falls back to a generic message.
function extractDetail(err: unknown): string | undefined {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === 'object' && 'detail' in data) {
    const d = (data as { detail?: unknown }).detail;
    if (typeof d === 'string') return d;
  }
  return undefined;
}

function pct(raised: number, goal: number): string {
  return `${Math.min(100, Math.round((raised / goal) * 100))}%`;
}

const CAMPAIGN_BASE_URL = 'https://pamojahub.co.ke/campaigns';

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<CampaignStatus, { bg: string; text: string }> = {
  ACTIVE:  { bg: Colors.successLight, text: Colors.success },
  PAUSED:  { bg: Colors.warningLight, text: Colors.warning },
  CLOSED:  { bg: Colors.grey,         text: Colors.textMuted },
};

function StatusBadge({ status }: { status: CampaignStatus }) {
  const c = STATUS_COLORS[status];
  return (
    <View style={[styles.statusBadge, { backgroundColor: c.bg }]}>
      <Text style={[styles.statusBadgeText, { color: c.text }]}>
        {status.charAt(0) + status.slice(1).toLowerCase()}
      </Text>
    </View>
  );
}

// ─── Group badge ──────────────────────────────────────────────────────────────

function GroupBadge({ name }: { name: string }) {
  return (
    <View style={styles.groupBadge}>
      <Text style={styles.groupBadgeText}>{name}</Text>
    </View>
  );
}

// ─── WhatsApp share (compact icon + label inline) ─────────────────────────────

function CompactShareBtn({ title, id }: { title: string; id: string }) {
  async function handleShare() {
    const msg = `Support our campaign: ${title}\n${CAMPAIGN_BASE_URL}/${id}`;
    const waUrl = `whatsapp://send?text=${encodeURIComponent(msg)}`;
    const canOpen = await Linking.canOpenURL(waUrl).catch(() => false);
    Linking.openURL(canOpen ? waUrl : `https://wa.me/?text=${encodeURIComponent(msg)}`);
  }

  return (
    <TouchableOpacity
      style={styles.shareBtn}
      onPress={handleShare}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`Share ${title} on WhatsApp`}
    >
      <Ionicons name="logo-whatsapp" size={16} color="#25D366" />
      <Text style={styles.shareBtnText}>Share</Text>
    </TouchableOpacity>
  );
}

// ─── Campaign row card ────────────────────────────────────────────────────────

interface CampaignRowProps {
  item: TreasurerCampaign;
  onPause: (slug: string) => void;
  onResume: (slug: string) => void;
  onClose: (slug: string) => void;
  onView: (slug: string) => void;
  busy: boolean;
}

const CampaignRowCard = React.memo(function CampaignRowCard({
  item,
  onPause,
  onResume,
  onClose,
  onView,
  busy,
}: CampaignRowProps) {
  const initial = (item.groupLabelName ?? item.title).charAt(0).toUpperCase();

  return (
    <View style={styles.card}>
      {/* Tappable area — navigates to detail, no nested buttons here */}
      <TouchableOpacity
        onPress={() => onView(item.slug)}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={`View details for ${item.title}`}
      >
        {/* Header: mini-banner + title + badges */}
        <View style={styles.cardHeader}>
          <View style={styles.miniBanner}>
            <Text style={styles.miniBannerText}>{initial}</Text>
          </View>
          <View style={styles.cardTitleSection}>
            <Text style={styles.cardTitle} numberOfLines={2}>
              {item.title}
            </Text>
            <View style={styles.badgeRow}>
              {item.groupLabelName ? <GroupBadge name={item.groupLabelName} /> : null}
              <StatusBadge status={item.status} />
            </View>
          </View>
          <Ionicons name="chevron-forward" size={18} color={Colors.textMuted} style={styles.chevron} />
        </View>

        {/* Money block — raised figure large in teal, goal + funded pill */}
        <View style={styles.moneyBlock}>
          <View style={styles.moneyLeft}>
            <Text style={styles.raisedValue} numberOfLines={1} adjustsFontSizeToFit>
              {fmtKes(item.walletBalance)}
            </Text>
            <Text style={styles.goalCaption} numberOfLines={1}>
              raised of {fmtKes(item.goalAmount)} goal
            </Text>
          </View>
          <View style={styles.fundedPill}>
            <Text style={styles.fundedPillText}>{pct(item.walletBalance, item.goalAmount)}</Text>
            <Text style={styles.fundedPillLabel}>funded</Text>
          </View>
        </View>

        {/* Progress bar */}
        <View style={styles.progressWrapper}>
          <ProgressBar
            raised={item.walletBalance}
            goal={item.goalAmount}
            height={7}
            showLabels={false}
          />
        </View>
      </TouchableOpacity>

      {/* Action row — lives outside the tappable area, no nesting */}
      <View style={styles.actionsRow}>
        <CompactShareBtn title={item.title} id={item.id} />

        <View style={styles.statusActions}>
          {item.status === 'ACTIVE' ? (
            <TouchableOpacity
              style={[styles.pauseBtn, busy && styles.btnDisabled]}
              onPress={() => onPause(item.slug)}
              disabled={busy}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Pause campaign"
            >
              <Ionicons name="pause-circle-outline" size={15} color={Colors.textSecondary} />
              <Text style={styles.pauseBtnText}>{busy ? 'Pausing…' : 'Pause'}</Text>
            </TouchableOpacity>
          ) : null}

          {item.status === 'PAUSED' ? (
            <TouchableOpacity
              style={[styles.resumeBtn, busy && styles.btnDisabled]}
              onPress={() => onResume(item.slug)}
              disabled={busy}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Resume campaign"
            >
              <Ionicons name="play-circle-outline" size={15} color={Colors.primary} />
              <Text style={styles.resumeBtnText}>{busy ? 'Resuming…' : 'Resume'}</Text>
            </TouchableOpacity>
          ) : null}

          {item.status !== 'CLOSED' ? (
            <TouchableOpacity
              style={[styles.closeBtn, busy && styles.btnDisabled]}
              onPress={() => onClose(item.slug)}
              disabled={busy}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Close campaign"
            >
              <Ionicons name="close-circle-outline" size={15} color={Colors.danger} />
              <Text style={styles.closeBtnText}>{busy ? 'Closing…' : 'Close'}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </View>
  );
});

// ─── Campaigns screen ─────────────────────────────────────────────────────────

export default function TreasurerCampaignsScreen() {
  const isWideWeb = useIsWideWeb();
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<TreasurerCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [search, setSearch] = useState('');
  // Pause/Resume write state. actingSlug holds the slug currently being acted on so
  // only that row's buttons disable; actionError is a screen-level inline message
  // (no Modal here → no occlusion, but the screen has no toast system, so a small
  // banner is the feedback channel).
  const [actingSlug, setActingSlug] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Close is destructive → confirm first. ResponsiveSheet, NOT Alert.alert — Alert
  // no-ops on react-native-web, which left the old confirm dead on web. Holds the
  // campaign being confirmed (null = sheet hidden).
  const [closeTarget, setCloseTarget] = useState<TreasurerCampaign | null>(null);

  // Authed GET /campaigns/mine/ (church-scoped server-side). Read-only here — the
  // pause/resume/close handlers below stay LOCAL-only (write/status slice is later).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const data = await campaignsService.listMine();
        if (!cancelled) setCampaigns(data);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  // ── Derived data ────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return campaigns.filter(c => !q || c.title.toLowerCase().includes(q));
  }, [campaigns, search]);

  // ── Pause / Resume / Close (wired: write → refetch from server truth; NO optimistic flip) ──

  async function runStatusAction(slug: string, action: 'pause' | 'resume' | 'close') {
    if (actingSlug) return;             // re-entry guard: one action in flight at a time
    setActionError(null);
    setActingSlug(slug);
    try {
      if (action === 'pause') await campaignsService.pauseCampaign(slug);
      else if (action === 'resume') await campaignsService.resumeCampaign(slug);
      else await campaignsService.closeCampaign(slug);
      // SUCCESS (200): re-sync the list from the server (same path as "Try again").
      // The row flips only now, from server truth — no optimistic mutation.
      setReloadKey(k => k + 1);
    } catch (err) {
      // Do NOT flip the row. Surface the reason. A 400 (detail present) — wrong-status
      // race OR the backend in-flight-money guard ("…withdrawal in progress…") — gets
      // shown and triggers a refetch so the stale row self-corrects. A bare network
      // failure (no detail) leaves the list as-is and shows the generic message.
      const detail = extractDetail(err);
      setActionError(detail ?? "Couldn't update. Try again.");
      if (detail !== undefined) setReloadKey(k => k + 1);
    } finally {
      setActingSlug(null);
    }
  }

  function handlePause(slug: string) { runStatusAction(slug, 'pause'); }
  function handleResume(slug: string) { runStatusAction(slug, 'resume'); }

  function handleClose(slug: string) {
    if (actingSlug) return;             // re-entry guard before opening a second confirm
    const campaign = campaigns.find(c => c.slug === slug);
    if (!campaign) return;
    setCloseTarget(campaign);           // opens the ResponsiveSheet confirm
  }

  // Routed through the SAME runner as pause/resume: no optimistic flip — the row
  // only goes CLOSED after the server confirms (and the in-flight-money guard's 400
  // surfaces inline via actionError).
  async function confirmClose() {
    if (!closeTarget || actingSlug) return;
    const slug = closeTarget.slug;
    await runStatusAction(slug, 'close');
    setCloseTarget(null);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <View style={styles.root}>
      {/* ── Sticky action bar ── */}
      <View style={styles.actionBar}>
        <View style={[styles.actionBarInner, isWideWeb && styles.wideCap]}>
          <TouchableOpacity
            style={styles.newCampaignBtn}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onPress={() => router.push('/(treasurer)/campaigns/new' as any)}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Create new campaign"
          >
            <Ionicons name="add-circle-outline" size={18} color={Colors.white} />
            <Text style={styles.newCampaignBtnText}>New Campaign</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.manageGroupsBtn}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onPress={() => router.push('/(treasurer)/groups' as any)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Manage group labels"
          >
            <Ionicons name="pricetags-outline" size={16} color={Colors.primary} />
            <Text style={styles.manageGroupsBtnText}>Group Labels</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Filter bar ── */}
      <View style={styles.filterBar}>
        <View style={isWideWeb && styles.wideCap}>
          {/* Search */}
          <View style={styles.searchRow}>
            <Ionicons name="search-outline" size={18} color={Colors.textMuted} style={styles.searchIcon} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search campaigns…"
              placeholderTextColor={Colors.textMuted}
              value={search}
              onChangeText={setSearch}
              returnKeyType="search"
              accessibilityLabel="Search campaigns"
            />
            {search.length > 0 ? (
              <TouchableOpacity
                onPress={() => setSearch('')}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel="Clear search"
              >
                <Ionicons name="close-circle" size={18} color={Colors.textMuted} />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      </View>

      {/* ── Action error banner (pause/resume write failures) ── */}
      {actionError ? (
        <TouchableOpacity
          style={styles.actionErrorBanner}
          onPress={() => setActionError(null)}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Dismiss error"
        >
          <Ionicons name="alert-circle-outline" size={16} color={Colors.danger} />
          <Text style={styles.actionErrorText}>{actionError}</Text>
          <Ionicons name="close" size={16} color={Colors.danger} />
        </TouchableOpacity>
      ) : null}

      {/* ── Campaign list ── */}
      {loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.emptyState}>
          <View style={styles.emptyIconCircle}>
            <Ionicons name="cloud-offline-outline" size={28} color={Colors.primary} />
          </View>
          <Text style={styles.emptyTitle}>Couldn’t load campaigns</Text>
          <Text style={styles.emptySubtitle}>Please check your connection and try again.</Text>
          <TouchableOpacity
            style={styles.retryBtnState}
            onPress={() => setReloadKey(k => k + 1)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text style={styles.retryBtnStateText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => item.id}
          renderItem={({ item }) => (
            <CampaignRowCard
              item={item}
              onPause={handlePause}
              onResume={handleResume}
              onClose={handleClose}
              onView={(slug) => router.push(`/(treasurer)/campaigns/${slug}` as any)}
              busy={actingSlug === item.slug}
            />
          )}
          contentContainerStyle={[styles.listContent, isWideWeb && styles.wideCap]}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <View style={styles.emptyIconCircle}>
                <Ionicons name="grid-outline" size={28} color={Colors.primary} />
              </View>
              <Text style={styles.emptyTitle}>No campaigns found</Text>
              <Text style={styles.emptySubtitle}>
                {search
                  ? 'No campaigns match your search.'
                  : 'Create your first campaign to get started.'}
              </Text>
            </View>
          }
        />
      )}

      {/* ── Close-campaign confirm (destructive → explicit web-safe confirm) ── */}
      <ResponsiveSheet
        visible={closeTarget !== null}
        onRequestClose={() => setCloseTarget(null)}
        dismissable={!actingSlug}
      >
        <Text style={styles.confirmTitle}>Close Campaign</Text>
        <Text style={styles.confirmBody}>
          Close “{closeTarget?.title}”?{'\n\n'}Donors will no longer be able to contribute.
          This cannot be undone.
        </Text>
        <View style={styles.confirmActions}>
          <TouchableOpacity
            style={[styles.confirmCancelBtn, actingSlug && styles.btnDisabled]}
            onPress={() => setCloseTarget(null)}
            disabled={!!actingSlug}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={styles.confirmCancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.confirmCloseBtn, actingSlug && styles.btnDisabled]}
            onPress={confirmClose}
            disabled={!!actingSlug}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Confirm close campaign"
          >
            <Text style={styles.confirmCloseText}>
              {actingSlug ? 'Closing…' : 'Close Campaign'}
            </Text>
          </TouchableOpacity>
        </View>
      </ResponsiveSheet>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.surfaceSubtle,
  },

  // Close-confirm sheet (mirrors the detail screen's confirm styles)
  confirmTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
    marginBottom: Spacing.sm,
  },
  confirmBody: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    lineHeight: FontSize.md * 1.6,
    marginBottom: Spacing.md,
  },
  confirmActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  confirmCancelBtn: {
    flex: 1,
    height: Spacing.touch,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmCancelText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
  },
  confirmCloseBtn: {
    flex: 1,
    height: Spacing.touch,
    borderRadius: BorderRadius.pill,
    backgroundColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmCloseText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.white,
  },

  // Filter bar
  filterBar: {
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
    paddingVertical: Spacing.sm,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: Spacing.md,
    height: 44,
    backgroundColor: Colors.surfaceSubtle,
    borderRadius: BorderRadius.pill,
    paddingHorizontal: Spacing.md,
    gap: 6,
  },
  searchIcon: {
    marginRight: 2,
  },
  searchInput: {
    flex: 1,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.text,
    height: 42,
  },
  // List
  listContent: {
    padding: Spacing.md,
    paddingBottom: Spacing.md,
  },
  separator: {
    height: Spacing.sm,
  },

  // Campaign card
  card: {
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    padding: Spacing.md,
    ...Shadows.sm,
  },

  // Card header
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 12,
  },
  miniBanner: {
    width: 48,
    height: 48,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  miniBannerText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xl,
    color: Colors.primary,
  },
  cardTitleSection: {
    flex: 1,
    gap: 5,
  },
  chevron: {
    alignSelf: 'center',
    flexShrink: 0,
  },
  cardTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.text,
    lineHeight: 20,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },

  // Status badge
  statusBadge: {
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  statusBadgeText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: 10,
  },

  // Group badge
  groupBadge: {
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  groupBadgeText: {
    fontFamily: 'Poppins-Medium',
    fontSize: 10,
    color: Colors.primaryDark,
  },

  // Money block
  moneyBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
    marginBottom: 10,
  },
  moneyLeft: {
    flex: 1,
    minWidth: 0,
  },
  raisedValue: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.xxl,
    color: Colors.primary,
    lineHeight: FontSize.xxl * 1.25,
  },
  goalCaption: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 1,
  },
  fundedPill: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.accentLight,
    borderRadius: BorderRadius.lg,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 56,
    flexShrink: 0,
  },
  fundedPillText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.accentDark,
    lineHeight: FontSize.lg * 1.15,
  },
  fundedPillLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: 9,
    letterSpacing: 0.5,
    color: Colors.accentDark,
    textTransform: 'uppercase',
  },

  // Progress bar
  progressWrapper: {
    marginBottom: 12,
  },

  // Action row
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: Colors.borderLight,
    paddingTop: 12,
  },

  // Share button
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    height: 38,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: '#25D366',
    backgroundColor: Colors.white,
  },
  shareBtnText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: '#25D366',
  },

  // Status actions
  statusActions: {
    flexDirection: 'row',
    gap: 6,
  },
  btnDisabled: { opacity: 0.5 },

  // Action error banner (pause/resume write failures)
  actionErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.dangerLight,
    marginHorizontal: Spacing.md,
    marginTop: Spacing.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 8,
    borderRadius: BorderRadius.lg,
  },
  actionErrorText: {
    flex: 1,
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.danger,
  },
  pauseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    height: 38,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
  },
  pauseBtnText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  resumeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    height: 38,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryLight,
  },
  resumeBtnText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },
  closeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    height: 38,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.danger,
    backgroundColor: Colors.dangerLight,
  },
  closeBtnText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.danger,
  },

  // Sticky action bar
  actionBar: {
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  actionBarInner: {
    flexDirection: 'row',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  wideCap: {
    maxWidth: 760,
    width: '100%',
    alignSelf: 'center',
  },
  newCampaignBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.accent,
    borderRadius: BorderRadius.pill,
    height: 44,
    gap: 6,
  },
  newCampaignBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.sm,
    color: Colors.white,
  },
  manageGroupsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 44,
    gap: 6,
    paddingHorizontal: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.pill,
    backgroundColor: Colors.white,
  },
  manageGroupsBtnText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },

  // Loading / empty / error states
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: 60,
    gap: Spacing.sm,
  },
  emptyIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
    marginTop: Spacing.sm,
  },
  emptySubtitle: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: Spacing.xl,
  },
  retryBtnState: {
    marginTop: Spacing.md,
    paddingHorizontal: Spacing.xl,
    height: Spacing.touch,
    borderRadius: BorderRadius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryBtnStateText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.white,
  },
});
