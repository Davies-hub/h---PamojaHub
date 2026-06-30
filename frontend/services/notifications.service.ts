// Notifications service — wired to the Slice-1 read API (GET list / unread-count,
// POST {id}/read / read-all). All four calls go through the shared `api` axios
// client (services/api.ts), so the real JWT request interceptor + refresh-and-retry
// apply; never a raw fetch.

import { api } from './api';
import { Notification, NotificationType, PaginatedResponse } from '../types';

// Shape returned by NotificationSerializer (backend notifications/serializers.py),
// grounded against a real row (Slice-2a 0c/0d): related_campaign / related_withdrawal
// are a PrimaryKeyRelatedField → a UUID-string PK OR null. STRICT per-field allowlist
// (same discipline as services/mappers.ts) — no generic deep-convert.
export interface BackendNotification {
  id: string;
  notification_type: string;
  title: string;
  message: string;
  related_campaign: string | null;    // PK or null
  related_withdrawal: string | null;  // PK or null
  is_read: boolean;
  created_at: string;
}

export function mapNotification(b: BackendNotification): Notification {
  return {
    id: b.id,
    notificationType: b.notification_type as NotificationType,
    title: b.title,
    message: b.message,
    relatedCampaignId: b.related_campaign ?? undefined,     // null → undefined (else the PK)
    relatedWithdrawalId: b.related_withdrawal ?? undefined,  // null → undefined (else the PK)
    isRead: b.is_read,
    createdAt: b.created_at,
  };
}

export const notificationsService = {
  // GET /notifications/ → paginated; map each result, PRESERVE {count, results}
  // (PaginatedResponse — the FE shape the screen reads `.results` off of).
  async list(): Promise<PaginatedResponse<Notification>> {
    const data = (await api.get<PaginatedResponse<BackendNotification>>('/notifications/')).data;
    return { ...data, results: (data.results ?? []).map(mapNotification) };
  },

  // GET /notifications/unread-count/ → {count} (used by the bell in Slice 2b).
  async getUnreadCount(): Promise<{ count: number }> {
    return (await api.get<{ count: number }>('/notifications/unread-count/')).data;
  },

  // POST /notifications/{id}/read/ → the updated, serialized row (mapped).
  async markRead(id: string): Promise<Notification> {
    return mapNotification((await api.post<BackendNotification>(`/notifications/${id}/read/`)).data);
  },

  // POST /notifications/read-all/ → {updated: N}.
  async markAllRead(): Promise<{ updated: number }> {
    return (await api.post<{ updated: number }>('/notifications/read-all/')).data;
  },
};
