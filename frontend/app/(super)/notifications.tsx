import React from 'react';
import { NotificationsList } from '../../components/notifications/NotificationsList';

// Super-admin notifications — the SAME recipient-scoped list as the treasurer's,
// showing this admin's own notifications (primarily RECONCILIATION_PAYMENT_CONFIRMED
// alerts for stranded payouts awaiting resolution). Back-target is the super landing
// (Queue). Registered as a hidden tab (href:null) in (super)/_layout.tsx; reached from
// the top-bar bell.
export default function SuperNotificationsScreen() {
  return <NotificationsList backHref="/(super)/" backLabel="Queue" />;
}
