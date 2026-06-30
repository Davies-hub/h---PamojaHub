import { Notification } from '../types';

export const mockNotifications: Notification[] = [
  {
    id: 'notif-1',
    notificationType: 'DONATION_RECEIVED',
    title: 'New donation received',
    message: 'Grace Wanjiku donated KES 1,950 to District 5 Classroom Desks Fund.',
    relatedCampaignId: '1',
    isRead: false,
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  },
  {
    id: 'notif-2',
    notificationType: 'DISBURSEMENT_SUBMITTED',
    title: 'Payout request submitted',
    message: "A payout request of KES 20,000 has been submitted for Women's Guild Meeting Hall Roof.",
    relatedCampaignId: '2',
    isRead: false,
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'notif-3',
    notificationType: 'DISBURSEMENT_SUBMITTED',
    title: 'Payout request pending',
    message: 'A payout request of KES 15,000 is awaiting your approval.',
    isRead: false,
    createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'notif-4',
    notificationType: 'DONATION_RECEIVED',
    title: 'New donation received',
    message: 'Joseph Kamau donated KES 4,875 to District 5 Classroom Desks Fund.',
    relatedCampaignId: '1',
    isRead: true,
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  },
];
