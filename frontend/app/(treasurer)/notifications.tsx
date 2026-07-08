import React from 'react';
import { NotificationsList } from '../../components/notifications/NotificationsList';

// Thin route wrapper — the whole screen body lives in the shared, role-neutral
// NotificationsList (also used by the super-admin notifications screen). The only
// per-role bits are the back-navigation target + label.
export default function NotificationsScreen() {
  return <NotificationsList backHref="/(treasurer)/" backLabel="Overview" />;
}
