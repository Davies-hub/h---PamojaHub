import { Campaign, PublicCampaign } from '../types';
import { mockWithdrawals } from './withdrawals.mock';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function paidTotal(campaignId: string): number {
  return mockWithdrawals
    .filter(w => w.campaignId === campaignId && w.status === 'PAID')
    .reduce((s, w) => s + w.amount, 0);
}

// ─── Canonical campaign seeds (all fields except derived walletBalance) ────────

type CampaignSeed = Omit<Campaign, 'walletBalance'> & { donorCount: number };

const seeds: CampaignSeed[] = [
  {
    id: 'tc1',
    slug: 'district-5-classroom-desks-fund',
    churchId: 'church-1',
    churchName: 'PCEA Bahati Martyrs',
    groupLabelId: 'gl-district-5',
    groupLabelName: 'District 5',
    title: 'District 5 Classroom Desks Fund',
    description: 'Help us equip the District 5 primary school with 80 quality desk-and-bench sets for Standards 4–8. Every desk funded means one more child with a proper place to learn.',
    goalAmount: 80000,
    raisedAmount: 50700,
    status: 'ACTIVE',
    bannerImageUrl: 'https://picsum.photos/seed/district-5-classroom-desks-fund/800/400',
    category: 'Education',
    treasurerPhone: '0712345678',
    treasurerName: 'David Mwangi',
    donorCount: 87,
    createdAt: '2025-01-15T08:00:00.000Z',
  },
  {
    id: 'tc2',
    slug: 'womens-guild-meeting-hall-roof',
    churchId: 'church-1',
    churchName: 'PCEA Bahati Martyrs',
    groupLabelId: 'gl-womens-guild',
    groupLabelName: "Women's Guild",
    title: "Women's Guild Meeting Hall Roof",
    description: "The Women's Guild meeting hall has served the congregation for over 30 years. The ageing iron sheet roof needs full replacement before the long rains.",
    goalAmount: 150000,
    raisedAmount: 95550,
    status: 'ACTIVE',
    bannerImageUrl: 'https://picsum.photos/seed/womens-guild-meeting-hall-roof/800/400',
    category: 'Building',
    treasurerPhone: '0722987654',
    treasurerName: 'Grace Njeri',
    donorCount: 163,
    createdAt: '2024-11-01T09:00:00.000Z',
  },
  {
    id: 'tc3',
    slug: 'cathedral-roof-restoration',
    churchId: 'church-2',
    churchName: "ACK St. Paul's Cathedral",
    title: 'Cathedral Roof Restoration',
    description: "The historic St. Paul's Cathedral roof requires urgent restoration work. Help us preserve this landmark for future generations of Nairobi's Anglican community.",
    goalAmount: 2500000,
    raisedAmount: 2437500,
    status: 'ACTIVE',
    bannerImageUrl: 'https://picsum.photos/seed/cathedral-roof-restoration/800/400',
    category: 'Building',
    treasurerPhone: '0733111222',
    treasurerName: 'Samuel Otieno',
    donorCount: 243,
    createdAt: '2026-02-01T08:00:00.000Z',
  },
  {
    id: 'tc4',
    slug: 'sunday-school-books-and-supplies',
    churchId: 'church-2',
    churchName: "ACK St. Paul's Cathedral",
    groupLabelId: 'gl-sunday-school',
    groupLabelName: 'Sunday School',
    title: 'Sunday School Books & Supplies',
    description: 'Equip 120 children with Bibles, stationery, and teaching materials for our Sunday School programme. Every contribution sends another child into worship fully equipped.',
    goalAmount: 45000,
    raisedAmount: 40462.5,
    status: 'ACTIVE',
    bannerImageUrl: 'https://picsum.photos/seed/sunday-school-books-and-supplies/800/400',
    category: 'Education',
    treasurerPhone: '0712555666',
    treasurerName: 'Esther Achieng',
    donorCount: 28,
    createdAt: '2026-04-10T08:00:00.000Z',
  },
  {
    id: 'tc5',
    slug: 'elders-meeting-room-renovation',
    churchId: 'church-1',
    churchName: 'PCEA Bahati Martyrs',
    title: 'Elders Meeting Room Renovation',
    description: 'Renovation of the elders meeting room: new floor tiles, repainting, drop ceiling, and air conditioning. Campaign paused pending contractor quotes.',
    goalAmount: 120000,
    raisedAmount: 34125,
    status: 'PAUSED',
    bannerImageUrl: 'https://picsum.photos/seed/elders-meeting-room-renovation/800/400',
    category: 'Building',
    treasurerPhone: '0701234567',
    treasurerName: 'Mzee Kamau',
    donorCount: 41,
    createdAt: '2024-10-20T10:00:00.000Z',
  },
  {
    id: 'tc6',
    slug: 'christmas-outreach-fund-2024',
    churchId: 'church-1',
    churchName: 'PCEA Bahati Martyrs',
    groupLabelId: 'gl-youth',
    groupLabelName: 'Youth',
    title: 'Christmas Outreach Fund 2024',
    description: 'Annual Christmas outreach: food hampers, stationery packs, and a Christmas party for 120 children in Mathare. Goal fully met — thank you to everyone who gave!',
    goalAmount: 30000,
    raisedAmount: 29250,
    status: 'CLOSED',
    bannerImageUrl: 'https://picsum.photos/seed/christmas-outreach-fund-2024/800/400',
    category: 'Relief',
    treasurerPhone: '0788999000',
    treasurerName: 'Mary Wambui',
    donorCount: 48,
    createdAt: '2024-11-20T08:00:00.000Z',
    closedAt: '2024-12-31T00:00:00.000Z',
  },
];

// ─── Master list — walletBalance derived from withdrawals data ────────────────

export const mockAllCampaigns: Campaign[] = seeds.map(s => ({
  ...s,
  walletBalance: s.raisedAmount - paidTotal(s.id),
}));

// ─── Public shape — no treasurer fields, no walletBalance, no churchId ─────────

export const mockPublicCampaigns: PublicCampaign[] = mockAllCampaigns.map(c => ({
  id: c.id,
  slug: c.slug,
  churchName: c.churchName,
  groupLabelName: c.groupLabelName,
  title: c.title,
  description: c.description,
  goalAmount: c.goalAmount,
  raisedAmount: c.raisedAmount,
  donorCount: c.donorCount ?? 0,
  status: c.status,
  bannerImageUrl: c.bannerImageUrl,
  documentUrl: c.documentUrl,
  category: c.category,
  createdAt: c.createdAt,
}));

// ─── Backwards-compat export ─────────────────────────────────────────────────

export const mockAdminCampaign: Campaign = mockAllCampaigns[0];
