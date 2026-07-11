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
import { useIsWideWeb } from '../../../components/layout/Screen';
import { BorderRadius, Colors, FontSize, Spacing } from '../../../constants/theme';
import { churchesService } from '../../../services/churches.service';
import { PublicChurch } from '../../../types';

// ─── Sub-components ───────────────────────────────────────────────────────────

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
      <Text style={styles.navTitle}>Browse Churches</Text>
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
        placeholder="Search by name, county or denomination…"
        placeholderTextColor={Colors.textMuted}
        value={value}
        onChangeText={onChange}
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
        accessibilityLabel="Search churches"
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

function ChurchCard({
  church,
  onPress,
}: {
  church: PublicChurch;
  onPress: () => void;
}) {
  const initials = church.name
    .split(' ')
    .slice(0, 2)
    .map(w => w[0] ?? '')
    .join('')
    .toUpperCase();
  const count = church.activeCampaignCount;   // from the API (no client-side counting)

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`View ${church.name}`}
    >
      <View style={styles.logoCircle}>
        <Text style={styles.logoText}>{initials}</Text>
      </View>

      <View style={styles.cardBody}>
        <Text style={styles.churchName} numberOfLines={2}>
          {church.name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {church.denomination}{church.county ? ` · ${church.county}` : ''}
        </Text>
        <Text style={[styles.campaignCount, count > 0 && styles.campaignCountActive]}>
          {count > 0
            ? `${count} active campaign${count !== 1 ? 's' : ''}`
            : 'No active campaigns'}
        </Text>
      </View>

      <Ionicons name="chevron-forward" size={18} color={Colors.textMuted} />
    </TouchableOpacity>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <View style={styles.empty}>
      <Ionicons name="business-outline" size={48} color={Colors.border} />
      <Text style={styles.emptyTitle}>No churches found</Text>
      <Text style={styles.emptySubtext}>
        {hasFilters
          ? 'Try a different name, county, or denomination.'
          : 'No registered churches yet.'}
      </Text>
    </View>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.empty}>
      <Ionicons name="cloud-offline-outline" size={48} color={Colors.border} />
      <Text style={styles.emptyTitle}>Couldn’t load churches</Text>
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

export default function BrowseChurchesScreen() {
  const router = useRouter();
  const isWideWeb = useIsWideWeb();
  const numColumns = isWideWeb ? 3 : 1;
  const [search, setSearch] = useState('');
  const [churches, setChurches] = useState<PublicChurch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Server-side search. Backend returns ACTIVE-only — NO client status filter
  // (the old `status === 'ACTIVE'` filter would empty the list, since status is
  // not in the public payload). Debounced so typing doesn't fire per keystroke.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    const timer = setTimeout(async () => {
      try {
        const q = search.trim();
        const res = await churchesService.browse(q ? { search: q } : undefined);
        if (!cancelled) setChurches(res.results);
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
  }, [search, reloadKey]);

  const hasFilters = search.trim().length > 0;

  return (
    <SafeAreaView edges={['top']} style={styles.root}>
      <View style={styles.stickyHeader}>
        <View style={isWideWeb && styles.wideCap}>
          <NavBar onBack={() => router.back()} />
          <View style={styles.searchWrapper}>
            <SearchBar value={search} onChange={setSearch} />
          </View>
        </View>
      </View>

      <View style={styles.content}>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={Colors.primary} />
          </View>
        ) : error ? (
          <ErrorState onRetry={() => setReloadKey(k => k + 1)} />
        ) : (
          <FlatList
            data={churches}
            numColumns={numColumns}
            key={numColumns}
            columnWrapperStyle={numColumns > 1 ? styles.gridRow : undefined}
            style={{ flex: 1, backgroundColor: Colors.background }}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
              <View style={isWideWeb && styles.gridItem}>
                <ChurchCard
                  church={item}
                  onPress={() => router.push(`/churches/${item.id}` as any)}
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

  // Wide-web content cap (nav/search/list all align to it)
  wideCap: {
    maxWidth: 1100,
    width: '100%',
    alignSelf: 'center',
  },

  // Church card
  listContent: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xl,
  },
  gridRow: {
    gap: Spacing.md,
  },
  gridItem: {
    flex: 1,
    maxWidth: '32%',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
    gap: Spacing.md,
  },
  logoCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  logoText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.lg,
    color: Colors.white,
  },
  cardBody: {
    flex: 1,
    gap: 2,
  },
  churchName: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.text,
    lineHeight: 20,
  },
  meta: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  campaignCount: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 4,
  },
  campaignCountActive: {
    color: Colors.primary,
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
