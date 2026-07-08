import { CampaignCategory, CampaignStatus } from '../types';
import { mockAllCampaigns } from './campaigns.mock';
import { mockWithdrawals } from './withdrawals.mock';

// ─── Derived summary (PCEA Bahati Martyrs = church-1) ────────────────────────

const _pceaCampaigns = mockAllCampaigns.filter(c => c.churchId === 'church-1');
const _pceaWithdrawals = mockWithdrawals.filter(w =>
  _pceaCampaigns.some(c => c.id === w.campaignId)
);

export const mockTreasurerSummary = {
  totalRaised:          _pceaCampaigns.reduce((s, c) => s + c.raisedAmount, 0),
  walletBalance:        _pceaCampaigns.reduce((s, c) => s + c.walletBalance, 0),
  totalDisbursed:       _pceaWithdrawals.filter(w => w.status === 'PAID').reduce((s, w) => s + w.amount, 0),
  activeCampaigns:      _pceaCampaigns.filter(c => c.status === 'ACTIVE').length,
  pendingDisbursements: _pceaWithdrawals.filter(w => w.status === 'PENDING_APPROVAL').length,
};

export interface RecentDonationRow {
  id: string;
  donorName?: string;
  campaignTitle: string;
  amount: number;       // gross — kept for M-Pesa receipt matching
  platformFee: number;
  netAmount: number;    // display value — Net per Net-Everywhere rule
  mpesaReceipt: string;
  createdAt: string;
}

export const mockRecentDonations: RecentDonationRow[] = [
  {
    id: 'd1',
    donorName: 'John Kamau',
    campaignTitle: 'District 5 Classroom Desks Fund',
    amount: 500,
    platformFee: 12.5,
    netAmount: 487.5,
    mpesaReceipt: 'QHX5K2L1WE',
    createdAt: new Date(Date.now() - 28 * 60 * 1000).toISOString(),
  },
  {
    id: 'd2',
    campaignTitle: "Women's Guild Meeting Hall Roof",
    amount: 2000,
    platformFee: 50,
    netAmount: 1950,
    mpesaReceipt: 'QGY3J8M4XR',
    createdAt: new Date(Date.now() - 105 * 60 * 1000).toISOString(),
  },
  {
    id: 'd3',
    donorName: 'Grace Wanjiku',
    campaignTitle: 'District 5 Classroom Desks Fund',
    amount: 1000,
    platformFee: 25,
    netAmount: 975,
    mpesaReceipt: 'QHN7P5R2KA',
    createdAt: new Date(Date.now() - 695 * 60 * 1000).toISOString(),
  },
  {
    id: 'd4',
    donorName: 'Peter Odhiambo',
    campaignTitle: "Women's Guild Meeting Hall Roof",
    amount: 5000,
    platformFee: 125,
    netAmount: 4875,
    mpesaReceipt: 'QJT4W9D6BM',
    createdAt: new Date(Date.now() - 895 * 60 * 1000).toISOString(),
  },
];

export interface TreasurerCampaignRow {
  id: string;
  title: string;
  groupLabelName?: string;
  goalAmount: number;
  raisedAmount: number;
  walletBalance: number;
  status: CampaignStatus;
  description?: string;
  category?: CampaignCategory;
  donorCount?: number;
  createdAt?: string;
}

// ─── Derived from master list — only PCEA campaigns (church-1) ────────────────

export const mockTreasurerCampaigns: TreasurerCampaignRow[] = mockAllCampaigns
  .filter(c => c.churchId === 'church-1')
  .map(c => ({
    id: c.id,
    title: c.title,
    groupLabelName: c.groupLabelName,
    goalAmount: c.goalAmount,
    raisedAmount: c.raisedAmount,
    walletBalance: c.walletBalance,
    status: c.status,
    description: c.description,
    category: c.category,
    donorCount: c.donorCount,
    createdAt: c.createdAt,
  }));
