import { describe, it, expect } from 'vitest';
import { mockAllCampaigns, mockPublicCampaigns } from '../mock/campaigns.mock';
import { mockTreasurerCampaigns, mockTreasurerSummary, mockRecentDonations } from '../mock/treasurer.mock';
import { mockWithdrawals } from '../mock/withdrawals.mock';
import { mockChurches } from '../mock/churches.mock';
import type { CampaignCategory, CampaignStatus, WithdrawalStatus } from '../types';

// ─── Group A — ID scheme consistency ─────────────────────────────────────────

describe('Group A — ID scheme consistency', () => {
  it('A1: every campaign ID matches /^tc\\d+$/', () => {
    for (const c of mockAllCampaigns) {
      expect(c.id, `campaign id ${c.id}`).toMatch(/^tc\d+$/);
    }
  });

  it('A2: every withdrawal campaignId exists in mockAllCampaigns', () => {
    const campaignIds = new Set(mockAllCampaigns.map(c => c.id));
    for (const w of mockWithdrawals) {
      expect(campaignIds.has(w.campaignId), `withdrawal ${w.id} campaignId "${w.campaignId}" not found`).toBe(true);
    }
  });

  it('A3: campaign IDs are unique', () => {
    const ids = mockAllCampaigns.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('A4: withdrawal IDs are unique', () => {
    const ids = mockWithdrawals.map(w => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('A5: every churchId in mockAllCampaigns exists in mockChurches', () => {
    const churchIds = new Set(mockChurches.map(ch => ch.id));
    for (const c of mockAllCampaigns) {
      expect(churchIds.has(c.churchId), `campaign ${c.id} churchId "${c.churchId}" not in mockChurches`).toBe(true);
    }
  });
});

// ─── Group B — Net-Everywhere arithmetic ─────────────────────────────────────

describe('Group B — Net-Everywhere arithmetic', () => {
  it('B1: raisedAmount <= goalAmount * 1.5 for every campaign', () => {
    for (const c of mockAllCampaigns) {
      expect(c.raisedAmount, `${c.id} raisedAmount`).toBeLessThanOrEqual(c.goalAmount * 1.5);
    }
  });

  it('B2: raisedAmount >= 0 and walletBalance >= 0 for every campaign', () => {
    for (const c of mockAllCampaigns) {
      expect(c.raisedAmount, `${c.id} raisedAmount`).toBeGreaterThanOrEqual(0);
      expect(c.walletBalance, `${c.id} walletBalance`).toBeGreaterThanOrEqual(0);
    }
  });

  it('B3: walletBalance === raisedAmount − sum(PAID withdrawals) for every campaign', () => {
    for (const c of mockAllCampaigns) {
      const paid = mockWithdrawals
        .filter(w => w.campaignId === c.id && w.status === 'PAID')
        .reduce((s, w) => s + w.amount, 0);
      expect(Math.abs(c.walletBalance - (c.raisedAmount - paid)), `${c.id} walletBalance drift`).toBeLessThan(0.01);
    }
  });

  it('B4: netAmount === amount − platformFee for every recent donation', () => {
    for (const d of mockRecentDonations) {
      expect(Math.abs(d.netAmount - (d.amount - d.platformFee)), `donation ${d.id}`).toBeLessThan(0.01);
    }
  });

  it('B5: platformFee is within 0.01 of amount * 0.025 for every recent donation', () => {
    for (const d of mockRecentDonations) {
      expect(Math.abs(d.platformFee - d.amount * 0.025), `donation ${d.id} fee`).toBeLessThan(0.01);
    }
  });
});

// ─── Group C — Cross-file campaign agreement ──────────────────────────────────

describe('Group C — Cross-file campaign agreement', () => {
  it('C1: every mockTreasurerCampaigns entry matches master on id/title/goalAmount/raisedAmount/walletBalance/status', () => {
    for (const tc of mockTreasurerCampaigns) {
      const master = mockAllCampaigns.find(c => c.id === tc.id);
      expect(master, `treasurer campaign ${tc.id} not in master`).toBeDefined();
      if (!master) continue;
      expect(tc.title).toBe(master.title);
      expect(tc.goalAmount).toBe(master.goalAmount);
      expect(tc.raisedAmount).toBe(master.raisedAmount);
      expect(tc.walletBalance).toBe(master.walletBalance);
      expect(tc.status).toBe(master.status);
    }
  });

  it('C2: every mockPublicCampaigns entry matches master on id/title/goalAmount/raisedAmount/status/donorCount', () => {
    for (const pc of mockPublicCampaigns) {
      const master = mockAllCampaigns.find(c => c.id === pc.id);
      expect(master, `public campaign ${pc.id} not in master`).toBeDefined();
      if (!master) continue;
      expect(pc.title).toBe(master.title);
      expect(pc.goalAmount).toBe(master.goalAmount);
      expect(pc.raisedAmount).toBe(master.raisedAmount);
      expect(pc.status).toBe(master.status);
      expect(pc.donorCount).toBe(master.donorCount ?? 0);
    }
  });

  it('C3: no mockPublicCampaigns entry has treasurerPhone, treasurerName, walletBalance, or churchId', () => {
    for (const pc of mockPublicCampaigns) {
      expect(Object.prototype.hasOwnProperty.call(pc, 'treasurerPhone'), `${pc.id} has treasurerPhone`).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(pc, 'treasurerName'), `${pc.id} has treasurerName`).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(pc, 'walletBalance'), `${pc.id} has walletBalance`).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(pc, 'churchId'), `${pc.id} has churchId`).toBe(false);
    }
  });

  it('C4: every campaignTitle in mockRecentDonations matches a title in mockAllCampaigns', () => {
    const titles = new Set(mockAllCampaigns.map(c => c.title));
    for (const d of mockRecentDonations) {
      expect(titles.has(d.campaignTitle), `donation ${d.id} title "${d.campaignTitle}" not found`).toBe(true);
    }
  });
});

// ─── Group D — Treasurer summary derivation ───────────────────────────────────

describe('Group D — Treasurer summary derivation', () => {
  const pceaCampaigns = mockAllCampaigns.filter(c => c.churchId === 'church-1');
  const pceaWithdrawals = mockWithdrawals.filter(w =>
    pceaCampaigns.some(c => c.id === w.campaignId)
  );

  it('D1: totalRaised equals sum of raisedAmount for church-1 campaigns', () => {
    const expected = pceaCampaigns.reduce((s, c) => s + c.raisedAmount, 0);
    expect(mockTreasurerSummary.totalRaised).toBe(expected);
  });

  it('D2: walletBalance equals sum of walletBalance for church-1 campaigns', () => {
    const expected = pceaCampaigns.reduce((s, c) => s + c.walletBalance, 0);
    expect(mockTreasurerSummary.walletBalance).toBe(expected);
  });

  it('D3: totalDisbursed equals sum of PAID withdrawal amounts for church-1 campaigns', () => {
    const expected = pceaWithdrawals.filter(w => w.status === 'PAID').reduce((s, w) => s + w.amount, 0);
    expect(mockTreasurerSummary.totalDisbursed).toBe(expected);
  });

  it('D4: activeCampaigns equals count of ACTIVE church-1 campaigns', () => {
    const expected = pceaCampaigns.filter(c => c.status === 'ACTIVE').length;
    expect(mockTreasurerSummary.activeCampaigns).toBe(expected);
  });

  it('D5: pendingDisbursements equals count of PENDING_APPROVAL withdrawals for church-1 campaigns', () => {
    const expected = pceaWithdrawals.filter(w => w.status === 'PENDING_APPROVAL').length;
    expect(mockTreasurerSummary.pendingDisbursements).toBe(expected);
  });
});

// ─── Group E — Status enum integrity ─────────────────────────────────────────

describe('Group E — Status enum integrity', () => {
  const validCampaignStatuses: CampaignStatus[] = ['ACTIVE', 'PAUSED', 'CLOSED'];
  const validWithdrawalStatuses: WithdrawalStatus[] = [
    'PENDING_APPROVAL', 'PROCESSING', 'PAID', 'FAILED', 'FAILED_FINAL', 'REJECTED',
  ];
  const validCategories: CampaignCategory[] = [
    'Building', 'Outreach', 'Youth', 'Education', 'Medical', 'Relief', 'Other',
  ];

  it('E1: every campaign status is a valid CampaignStatus', () => {
    for (const c of mockAllCampaigns) {
      expect(validCampaignStatuses, `${c.id} status "${c.status}"`).toContain(c.status);
    }
  });

  it('E2: every withdrawal status is a valid WithdrawalStatus', () => {
    for (const w of mockWithdrawals) {
      expect(validWithdrawalStatuses, `${w.id} status "${w.status}"`).toContain(w.status);
    }
  });

  it('E3: every campaign category is a valid CampaignCategory', () => {
    for (const c of mockAllCampaigns) {
      expect(validCategories, `${c.id} category "${c.category}"`).toContain(c.category);
    }
  });

  it('E4: CLOSED campaigns have closedAt; non-CLOSED campaigns have closedAt undefined', () => {
    for (const c of mockAllCampaigns) {
      if (c.status === 'CLOSED') {
        expect(c.closedAt, `${c.id} should have closedAt`).toBeDefined();
      } else {
        expect(c.closedAt, `${c.id} should not have closedAt`).toBeUndefined();
      }
    }
  });
});

// ─── Group F — Treasurer phone format ────────────────────────────────────────

describe('Group F — Phone format (Kenya M-Pesa)', () => {
  const kenyanPhone = /^(07|01)\d{8}$/;

  it('F1: every campaign treasurerPhone matches Kenyan phone pattern', () => {
    for (const c of mockAllCampaigns) {
      if (c.treasurerPhone) {
        expect(c.treasurerPhone, `${c.id} treasurerPhone`).toMatch(kenyanPhone);
      }
    }
  });

  it('F2: every withdrawal destinationPhone and requestedByPhone match Kenyan phone pattern', () => {
    for (const w of mockWithdrawals) {
      expect(w.destinationPhone, `${w.id} destinationPhone`).toMatch(kenyanPhone);
      expect(w.requestedByPhone, `${w.id} requestedByPhone`).toMatch(kenyanPhone);
    }
  });
});

// ─── Group G — Multi-tenant boundary ─────────────────────────────────────────

describe('Group G — Multi-tenant boundary', () => {
  it('G1: every mockTreasurerCampaigns entry has churchId === church-1 in master', () => {
    for (const tc of mockTreasurerCampaigns) {
      const master = mockAllCampaigns.find(c => c.id === tc.id);
      expect(master?.churchId, `${tc.id} should belong to church-1`).toBe('church-1');
    }
  });

  it('G2: withdrawal churchName matches its campaign churchName in master', () => {
    for (const w of mockWithdrawals) {
      if (!w.churchName) continue;
      const master = mockAllCampaigns.find(c => c.id === w.campaignId);
      if (!master) continue;
      expect(w.churchName, `${w.id} churchName mismatch`).toBe(master.churchName);
    }
  });
});

// ─── Group H — Coverage completeness ─────────────────────────────────────────

describe('Group H — Coverage completeness', () => {
  it('H1: mockAllCampaigns contains at least one of each status (ACTIVE, PAUSED, CLOSED)', () => {
    const statuses = new Set(mockAllCampaigns.map(c => c.status));
    expect(statuses.has('ACTIVE')).toBe(true);
    expect(statuses.has('PAUSED')).toBe(true);
    expect(statuses.has('CLOSED')).toBe(true);
  });

  it('H2: mockWithdrawals contains at least one of each WithdrawalStatus', () => {
    const statuses = new Set(mockWithdrawals.map(w => w.status));
    expect(statuses.has('PENDING_APPROVAL')).toBe(true);
    expect(statuses.has('PROCESSING')).toBe(true);
    expect(statuses.has('PAID')).toBe(true);
    expect(statuses.has('FAILED')).toBe(true);
    expect(statuses.has('FAILED_FINAL')).toBe(true);
    expect(statuses.has('REJECTED')).toBe(true);
  });

  it('H3: at least one campaign has walletBalance < raisedAmount AND at least one has walletBalance === raisedAmount', () => {
    const hasPayouts   = mockAllCampaigns.some(c => c.walletBalance < c.raisedAmount);
    const hasNoPayouts = mockAllCampaigns.some(c => c.walletBalance === c.raisedAmount);
    expect(hasPayouts, 'no campaign has payouts').toBe(true);
    expect(hasNoPayouts, 'no campaign without payouts').toBe(true);
  });
});
