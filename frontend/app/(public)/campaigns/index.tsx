import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import CampaignCard from '../../../components/campaign/CampaignCard';
import { useIsWideWeb } from '../../../components/layout/Screen';
import { BorderRadius, Colors, FontSize, Spacing } from '../../../constants/theme';
import { campaignsService } from '../../../services/campaigns.service';
import { CampaignCategory, PublicCampaign } from '../../../types';

const CATEGORIES: Array<CampaignCategory | 'All'> = [
  'All', 'Building', 'Education', 'Outreach', 'Youth', 'Medical', 'Relief', 'Other',
];

// ─── Header components ────────────────────────────────────────────────────────

function NavBar({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.nav}>
      <TouchableOpacity
        style={styles.navBtn}
        onPress={onBack}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <Ionicons name="arrow-back" size={22} color={Colors.white} />
      </TouchableOpacity>
      <Text style={styles.navTitle}>Browse Campaigns</Text>
      <View style={styles.navBtn} />
    </View>
  );
}

function SearchBar({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View style={styles.searchRow}>
      <Ionicons name="search-outline" size={18} color={Colors.textMuted} style={styles.searchIcon} />
      <TextInput
        style={styles.searchInput}
        placeholder="Search campaigns or churches…"
        placeholderTextColor={Colors.textMuted}
        value={value}
        onChangeText={onChange}
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
        accessibilityLabel="Search campaigns"
      />
      {value.length > 0 && (
        <TouchableOpacity
          onPress={() => onChange('')}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
        >
          <Ionicons name="close-circle" size={18} color={Colors.textMuted} />
        </TouchableOpacity>
      )}
    </View>
  );
}

function CategoryChips({
  selected,
  onSelect,
}: {
  selected: CampaignCategory | 'All';
  onSelect: (c: CampaignCategory | 'All') => void;
}) {
  return (
    <FlatList
      data={CATEGORIES}
      horizontal
      showsHorizontalScrollIndicator={false}
      keyExtractor={item => item}
      style={styles.chipListOuter}
      contentContainerStyle={styles.chipList}
      renderItem={({ item }) => {
        const active = item === selected;
        return (
          <TouchableOpacity
            style={[styles.chip, active && styles.chipActive]}
            onPress={() => onSelect(item)}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel={`Filter by ${item}`}
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{item}</Text>
          </TouchableOpacity>
        );
      }}
    />
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <View style={styles.empty}>
      <Ionicons name="search-outline" size={48} color={Colors.border} />
      <Text style={styles.emptyTitle}>No campaigns found</Text>
      <Text style={styles.emptySubtext}>
        {hasFilters
          ? 'Try a different search term or category.'
          : 'There are no active campaigns right now.'}
      </Text>
    </View>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.empty}>
      <Ionicons name="cloud-offline-outline" size={48} color={Colors.border} />
      <Text style={styles.emptyTitle}>Couldn’t load campaigns</Text>
      <Text style={styles.emptySubtext}>
        Please check your connection and try again.
      </Text>
      <TouchableOpacity
        style={styles.retryBtn}
        onPress={onRetry}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="Try again"
      >
        <Text style={styles.retryBtnText}>Try again</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function BrowseCampaignsScreen() {
  const router = useRouter();
  const isWideWeb = useIsWideWeb();
  const numColumns = isWideWeb ? 3 : 1;
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<CampaignCategory | 'All'>('All');
  const [campaigns, setCampaigns] = useState<PublicCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Server-side search + category (backend already returns ACTIVE-only — no client
  // status filter). Debounced so typing doesn't fire a request per keystroke.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    const timer = setTimeout(async () => {
      try {
        const params: { search?: string; category?: string } = {};
        const q = search.trim();
        if (q) params.search = q;
        if (category !== 'All') params.category = category;
        const res = await campaignsService.browse(params);
        if (!cancelled) setCampaigns(res.results);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, category, reloadKey]);

  const hasFilters = search.trim().length > 0 || category !== 'All';

  return (
    <SafeAreaView edges={['top']} style={styles.root}>
      {/* Sticky header: nav + search */}
      <View style={styles.stickyHeader}>
        <View style={isWideWeb && styles.wideCap}>
          <NavBar onBack={() => router.back()} />
          <View style={styles.searchWrapper}>
            <SearchBar value={search} onChange={setSearch} />
          </View>
        </View>
      </View>

      <View style={styles.content}>
        <View style={isWideWeb && styles.wideCap}>
          <CategoryChips selected={category} onSelect={setCategory} />
        </View>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={Colors.primary} />
          </View>
        ) : error ? (
          <ErrorState onRetry={() => setReloadKey(k => k + 1)} />
        ) : (
          <FlatList
            data={campaigns}
            numColumns={numColumns}
            key={numColumns}
            columnWrapperStyle={numColumns > 1 ? styles.gridRow : undefined}
            style={{ flex: 1, backgroundColor: Colors.background }}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
              <View style={isWideWeb && styles.gridItem}>
                <CampaignCard
                  campaign={item}
                  onDonate={() => router.push(`/campaigns/${item.slug}` as any)}
                />
              </View>
            )}
            ListEmptyComponent={<EmptyState hasFilters={hasFilters} />}
            contentContainerStyle={[styles.listContent, isWideWeb && styles.wideCap]}
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.primary,
  },

  // Sticky header
  stickyHeader: {
    backgroundColor: Colors.primary,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
  },
  nav: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.sm,
  },
  navBtn: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.white,
  },
  searchWrapper: {
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.md,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md,
    height: 44,
    gap: Spacing.sm,
  },
  searchIcon: {
    flexShrink: 0,
  },
  searchInput: {
    flex: 1,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.text,
    paddingVertical: 0,
  },

  // Category chips
  // flexGrow:0 stops the horizontal list from stretching to fill the flex:1
  // content column (RN-Web's ScrollView base is flexGrow:1) — which was
  // inflating the row and stretching each pill into a tall oval.
  chipListOuter: {
    flexGrow: 0,
  },
  chipList: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    gap: Spacing.sm,
    alignItems: 'center',
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  chipText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  chipTextActive: {
    color: Colors.white,
  },

  // Content area (below sticky header)
  content: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },

  // Wide-web content cap (nav/search/chips/list all align to it)
  wideCap: {
    maxWidth: 1100,
    width: '100%',
    alignSelf: 'center',
  },

  // List
  listContent: {
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.xl,
  },
  gridRow: {
    gap: Spacing.md,
  },
  gridItem: {
    flex: 1,
    maxWidth: '32%',
  },

  // Empty state
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    paddingHorizontal: Spacing.lg,
  },
  emptyTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
    marginTop: Spacing.md,
    marginBottom: 6,
  },
  emptySubtext: {
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
});
