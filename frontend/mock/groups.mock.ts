import { GroupLabel } from '../types';

export const mockGroupLabels: GroupLabel[] = [
  {
    id: 'g1',
    churchId: 'church-1',
    name: "Women's Guild",
    isArchived: false,
    activeCampaignCount: 1,
    createdAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'g2',
    churchId: 'church-1',
    name: 'Youth',
    isArchived: false,
    activeCampaignCount: 1,
    createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'g3',
    churchId: 'church-1',
    parentLabelId: 'g2',
    name: 'Youth - Music Ministry',
    isArchived: false,
    activeCampaignCount: 0,
    createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'g4',
    churchId: 'church-1',
    name: 'District 5',
    isArchived: false,
    activeCampaignCount: 1,
    createdAt: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'g5',
    churchId: 'church-1',
    name: 'Elders',
    isArchived: false,
    activeCampaignCount: 0,
    createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
  },
];
