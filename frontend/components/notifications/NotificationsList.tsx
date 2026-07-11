import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { useIsWideWeb } from '../layout/Screen';
import { useFocusRefetch } from '../../hooks/useFocusRefetch';
import { notificationsService } from '../../services/notifications.service';
import { useNotifications } from '../../stores/notifications.store';
import { Notification, NotificationType } from '../../types';
import { timeAgo } from '../../utils/formatters';

// Shared notifications list — the ROLE-NEUTRAL body of the notifications screen,
// used by BOTH (treasurer)/notifications.tsx and (super)/notifications.tsx. The read
// API (notificationsService) is recipient-scoped server-side, so the SAME component
// shows each signed-in user THEIR own notifications (treasurer payout events, or the
// super-admin's RECONCILIATION_PAYMENT_CONFIRMED alerts). The ONLY per-role bits are
// the back-navigation target + label, passed as props.

// ─── Notification icon by type ────────────────────────────────────────────────

const TYPE_ICON: Record<NotificationType, { name: React.ComponentProps<typeof Ionicons>['name']; color: string }> = {
  DONATION_RECEIVED:               { name: 'cash-outline',            color: Colors.success },
  DONATION_NEEDS_REVIEW:           { name: 'flag-outline',            color: Colors.warning },
  DISBURSEMENT_SUBMITTED:          { name: 'arrow-up-circle-outline', color: Colors.primary },
  DISBURSEMENT_APPROVED:           { name: 'checkmark-circle-outline', color: Colors.success },
  DISBURSEMENT_REJECTED:           { name: 'close-circle-outline',    color: Colors.danger },
  DISBURSEMENT_PAID:               { name: 'card-outline',            color: Colors.success },
  DISBURSEMENT_FAILED:             { name: 'alert-circle-outline',    color: Colors.danger },
  RECONCILIATION_PAYMENT_CONFIRMED:{ name: 'checkmark-done-circle-outline', color: Colors.primary },
  SUBSCRIPTION_REMINDER:           { name: 'time-outline',            color: Colors.warning },
  SUBSCRIPTION_LAPSED:             { name: 'warning-outline',         color: Colors.danger },
  SUBSCRIPTION_ACTIVATED:          { name: 'checkmark-circle-outline', color: Colors.success },
  CAMPAIGN_DESTINATION_CHANGED:    { name: 'git-branch-outline',      color: Colors.textSecondary },
};

// ─── Notification item ────────────────────────────────────────────────────────

function NotifItem({
  item,
  onMarkRead,
}: {
  item: Notification;
  onMarkRead: (id: string) => void;
}) {
  const icon = TYPE_ICON[item.notificationType] ?? { name: 'notifications-outline' as const, color: Colors.textMuted };

  return (
    <TouchableOpacity
      style={[styles.item, !item.isRead && styles.itemUnread]}
      onPress={() => onMarkRead(item.id)}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={item.title}
    >
      <View style={[styles.iconWrap, { backgroundColor: item.isRead ? Colors.grey : Colors.primaryLight }]}>
        <Ionicons name={icon.name} size={20} color={icon.color} />
      </View>
      <View style={styles.itemBody}>
        <View style={styles.itemTop}>
          <Text style={[styles.itemTitle, !item.isRead && styles.itemTitleUnread]}
            numberOfLines={1}
          >
            {item.title}
          </Text>
          {!item.isRead ? <View style={styles.unreadDot} /> : null}
        </View>
        <Text style={styles.itemMessage} numberOfLines={2}>
          {item.message}
        </Text>
        <Text style={styles.itemTime}>{timeAgo(item.createdAt)}</Text>
      </View>
    </TouchableOpacity>
  );
}

// ─── Shared screen body ─────────────────────────────────────────────────────────

export function NotificationsList({
  backHref,
  backLabel,
}: {
  backHref: string;
  backLabel: string;
}) {
  const router = useRouter();
  const { clearUnread } = useNotifications();
  const isWideWeb = useIsWideWeb();

  // Live read: fetch on every screen focus (background refetch on revisit keeps
  // last-good). `data` is the PaginatedResponse — we read `.results` into a local
  // mirror so the tap/mark handlers can flip optimistically while a focus-refetch
  // re-syncs the mirror to SERVER TRUTH (that re-sync is what makes a mark-read
  // survive navigate-away→back, not just an in-session flip).
  const { data, status, refetchError, retry } = useFocusRefetch(
    () => notificationsService.list(),
  );
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    if (data) setNotifications(data.results);
  }, [data]);

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        router.navigate(backHref as any);
        return true;
      });
      return () => sub.remove();
    }, [router, backHref])
  );

  const unreadCount = notifications.filter(n => !n.isRead).length;

  async function markRead(id: string) {
    // Optimistic flip for instant feedback, then persist; the background refetch
    // re-syncs to server truth (and reverts the flip if the POST didn't persist).
    setNotifications(prev =>
      prev.map(n => n.id === id ? { ...n, isRead: true } : n)
    );
    try {
      await notificationsService.markRead(id);
    } catch {
      // Swallow: the finally{retry()} re-syncs to server truth and the hook's
      // refetchError already surfaces the soft sync-notice. This only stops the
      // unhandled rejection (dev red-box); no revert/toast/state-change by design.
    } finally {
      retry();
    }
  }

  async function markAllRead() {
    setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
    clearUnread();
    try {
      await notificationsService.markAllRead();
    } catch {
      // Swallow: the finally{retry()} re-syncs to server truth and the hook's
      // refetchError already surfaces the soft sync-notice. This only stops the
      // unhandled rejection (dev red-box); no revert/toast/state-change by design.
    } finally {
      retry();
    }
  }

  return (
    <SafeAreaView edges={['bottom']} style={styles.root}>
      {/* Back bar */}
      <View style={[styles.backBar, isWideWeb && styles.wideColumn]}>
        <TouchableOpacity
          style={styles.backBtn}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onPress={() => router.navigate(backHref as any)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Go back to ${backLabel}`}
        >
          <Ionicons name="arrow-back" size={22} color={Colors.primary} />
          <Text style={styles.backBtnText}>{backLabel}</Text>
        </TouchableOpacity>
        <Text style={styles.backBarTitle}>Notifications</Text>
        <View style={styles.backBarSpacer} />
      </View>

      {status === 'loading' ? (
        <View style={[styles.centerBlock, isWideWeb && styles.wideColumn]}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : status === 'error' ? (
        <View style={[styles.errorBlock, isWideWeb && styles.wideColumn]}>
          <Ionicons name="cloud-offline-outline" size={40} color={Colors.border} />
          <Text style={styles.errorText}>Couldn’t load notifications.</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={retry}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text style={styles.retryBtnText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Header bar */}
          {unreadCount > 0 ? (
            <View style={[styles.headerBar, isWideWeb && styles.wideColumn]}>
              <Text style={styles.headerBarText}>
                {unreadCount} unread notification{unreadCount !== 1 ? 's' : ''}
              </Text>
              <TouchableOpacity
                onPress={markAllRead}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Mark all as read"
              >
                <Text style={styles.markAllText}>Mark all read</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {/* Background refetch failed but we kept last-good rows on screen — a soft,
              non-blocking sync warning (the optimistic mark-read may not have persisted).
              Driven by the hook's refetchError; auto-clears when a refetch next succeeds. */}
          {refetchError ? (
            <View style={[styles.syncBar, isWideWeb && styles.wideColumn]}>
              <Ionicons name="cloud-offline-outline" size={15} color={Colors.warning} />
              <Text style={styles.syncBarText}>
                Couldn’t sync — your last action may not have saved. Pull down or reopen to retry.
              </Text>
            </View>
          ) : null}

          <FlatList
            data={notifications}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
              <NotifItem item={item} onMarkRead={markRead} />
            )}
            contentContainerStyle={[styles.listContent, isWideWeb && styles.wideColumn]}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Ionicons name="notifications-off-outline" size={48} color={Colors.border} />
                <Text style={styles.emptyTitle}>No notifications</Text>
                <Text style={styles.emptySubtitle}>You're all caught up.</Text>
              </View>
            }
          />
        </>
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.grey },

  // Wide-web (≥768) only — list content and its outside-the-list siblings share
  // one centered 760 column.
  wideColumn: {
    maxWidth: 760,
    width: '100%',
    alignSelf: 'center',
  },

  backBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    paddingHorizontal: Spacing.md,
    height: 48,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    width: 72,
  },
  backBtnText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.base,
    color: Colors.primary,
  },
  backBarTitle: {
    flex: 1,
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
    textAlign: 'center',
  },
  backBarSpacer: { width: 72 },

  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerBarText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },
  markAllText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.primary,
  },

  // Loading / error blocks (mirror the wired super-admin screens' idiom).
  centerBlock: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorBlock: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.xl,
  },
  errorText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  retryBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    minHeight: Spacing.touch,
    justifyContent: 'center',
  },
  retryBtnText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.base,
    color: Colors.white,
  },

  listContent: {
    paddingVertical: Spacing.sm,
    paddingBottom: Spacing.xl,
  },

  separator: {
    height: 1,
    backgroundColor: Colors.border,
    marginLeft: 72,
  },

  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.white,
    gap: Spacing.md,
  },
  itemUnread: {
    backgroundColor: Colors.primaryLightest,
  },

  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },

  itemBody: { flex: 1, gap: 3 },

  itemTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  itemTitle: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    flex: 1,
  },
  itemTitleUnread: {
    fontFamily: 'Poppins-SemiBold',
    color: Colors.text,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.primary,
    flexShrink: 0,
  },
  itemMessage: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: FontSize.sm * 1.6,
  },
  itemTime: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },

  emptyState: {
    alignItems: 'center',
    paddingTop: 80,
    gap: Spacing.sm,
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
  },

  // Soft, non-blocking "couldn't sync" bar — lighter than the full status==='error'
  // block: a thin warning-tinted strip below the header, rows stay visible beneath.
  syncBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.warningLight,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  syncBarText: {
    flex: 1,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.warning,
  },
});
