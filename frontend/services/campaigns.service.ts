import { PaginatedResponse, PublicCampaign, TreasurerCampaign } from '../types';
import { api } from './api';
import {
  BackendPublicCampaign,
  BackendTreasurerCampaign,
  mapPublicCampaign,
  mapTreasurerCampaign,
} from './mappers';

// Writable-fields-only create input (camelCase). The backend SERVER-FORCES
// church / created_by / status=ACTIVE / raised=0 / wallet=0 and auto-generates the
// slug — those are never sent. group_label / banner_image_url / document_url are
// optional and OMITTED when empty (image upload is a later feature; "no group" is
// church-wide). goal_amount stays a STRING on the wire (DRF DecimalField).
export interface CreateCampaignInput {
  title: string;
  description: string;
  goalAmount: string;
  category: string;
  treasurerName: string;
  treasurerPhone: string;
  groupLabelId?: string | null;
  bannerImageUrl?: string;
  documentUrl?: string;
}

export const campaignsService = {
  // PARAMS: search (title), category (exact), church (by id). NOT county — the
  // backend campaign list ignores it (only churches filter by county).
  async browse(params?: { search?: string; category?: string; church?: string; page?: number }):
    Promise<PaginatedResponse<PublicCampaign>> {
    const { data } = await api.get<PaginatedResponse<BackendPublicCampaign>>('/campaigns/', { params });
    // Map snake→camel + decimal-string→number; keep the pagination envelope.
    return {
      count: data.count,
      next: data.next,
      previous: data.previous,
      results: data.results.map(mapPublicCampaign),
    };
  },

  // Authed: GET /campaigns/mine/ — the treasurer's own campaigns (church-scoped
  // server-side). Paginated; we return the mapped results array.
  async listMine(): Promise<TreasurerCampaign[]> {
    const { data } = await api.get<PaginatedResponse<BackendTreasurerCampaign>>('/campaigns/mine/');
    return data.results.map(mapTreasurerCampaign);
  },

  // Authed: GET /campaigns/mine/{slug}/ — the treasurer's own SINGLE campaign,
  // SLUG-keyed (AdminCampaignSerializer '__all__' → has wallet_balance + goal_amount
  // + donor_count, all NET). Church-scoped server-side (cross-church slug → 403 via
  // ChurchScopedPermission; non-existent → 404). A 4xx PROPAGATES (axios throws) so
  // the detail screen can show a distinct not-found state. Single object, not paginated.
  async getMine(slug: string): Promise<TreasurerCampaign> {
    const { data } = await api.get<BackendTreasurerCampaign>(`/campaigns/mine/${slug}/`);
    return mapTreasurerCampaign(data);
  },

  // Authed WRITE: POST /campaigns/mine/create/ — create a campaign for the
  // treasurer's own church. Body is the camel→snake of the WRITABLE fields only.
  // The 201 is AdminCampaignSerializer ('__all__') incl. the server-allocated slug;
  // we map it via mapTreasurerCampaign (the slug drives navigation to the detail).
  // 400s PROPAGATE (axios throws) so the screen surfaces them — both DRF field-error
  // shapes ({"goal_amount":[...]}, {"treasurer_phone":[...]}, ...) AND business-rule
  // {"detail": ...} (FREE-tier cap, cross-church group label).
  async create(input: CreateCampaignInput): Promise<TreasurerCampaign> {
    const body: Record<string, unknown> = {
      title: input.title,
      description: input.description,
      goal_amount: input.goalAmount,   // STRING on the wire (DecimalField)
      category: input.category,
      treasurer_name: input.treasurerName,
      treasurer_phone: input.treasurerPhone,
    };
    // group_label: send the id, or OMIT entirely for "no group / church-wide".
    if (input.groupLabelId) body.group_label = input.groupLabelId;
    // banner/document: optional; OMIT when empty (no URL collected yet).
    if (input.bannerImageUrl) body.banner_image_url = input.bannerImageUrl;
    if (input.documentUrl) body.document_url = input.documentUrl;

    const { data } = await api.post<BackendTreasurerCampaign>('/campaigns/mine/create/', body);
    return mapTreasurerCampaign(data);
  },

  async getBySlug(slug: string): Promise<PublicCampaign> {
    // The detail response carries an extra `updates` key; the screen doesn't render
    // updates, so mapPublicCampaign simply ignores it. A 404 propagates (axios throws)
    // so the screen can show a distinct not-found state.
    const { data } = await api.get<BackendPublicCampaign>(`/campaigns/${slug}/`);
    return mapPublicCampaign(data);
  },

  // Authed WRITE: POST /campaigns/mine/{slug}/pause/ — ACTIVE → PAUSED. No-body POST,
  // SLUG-keyed. The 200 body is AdminCampaignSerializer but the screen re-syncs from a
  // list refetch rather than the single response, so we return void and don't map it.
  // Errors PROPAGATE (no catch): the screen catches and decides (400 wrong-status =
  // someone else acted → refetch).
  async pauseCampaign(slug: string): Promise<void> {
    await api.post(`/campaigns/mine/${slug}/pause/`);
  },

  // Authed WRITE: POST /campaigns/mine/{slug}/resume/ — PAUSED → ACTIVE. Same shape.
  async resumeCampaign(slug: string): Promise<void> {
    await api.post(`/campaigns/mine/${slug}/resume/`);
  },

  // Authed WRITE: POST /campaigns/mine/{slug}/close/ — ACTIVE|PAUSED → CLOSED
  // (terminal). No-body, slug-keyed. The backend's in-flight-money guard may return
  // 400 ("…withdrawal in progress…"); that detail propagates like any other and the
  // screen surfaces it. Response not mapped; the list re-syncs via refetch.
  async closeCampaign(slug: string): Promise<void> {
    await api.post(`/campaigns/mine/${slug}/close/`);
  },
};
