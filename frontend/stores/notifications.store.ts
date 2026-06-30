import React, { createContext, useCallback, useContext, useState } from 'react';

interface NotificationsState {
  unreadCount: number;
  setUnreadCount: (count: number) => void;
  decrementUnread: () => void;
  clearUnread: () => void;
}

const NotificationsContext = createContext<NotificationsState | null>(null);

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  // Starts at 0 — no fake seed. The REAL count is pushed by the Overview bell
  // (Slice 2b) via setUnreadCount on focus; the badge never shows a hardcoded number.
  const [unreadCount, setUnreadCountState] = useState(0);

  // Stable identities (useCallback) so a focus-effect that depends on setUnreadCount
  // does not re-subscribe every time the count changes.
  const setUnreadCount = useCallback((count: number) => setUnreadCountState(count), []);
  const decrementUnread = useCallback(() => setUnreadCountState(prev => Math.max(0, prev - 1)), []);
  const clearUnread = useCallback(() => setUnreadCountState(0), []);

  return React.createElement(
    NotificationsContext.Provider,
    { value: { unreadCount, setUnreadCount, decrementUnread, clearUnread } },
    children
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications must be inside NotificationsProvider');
  return ctx;
}
