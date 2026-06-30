import { GroupLabel, PaginatedResponse } from '../types';
import { api } from './api';
import { BackendGroupLabel, mapGroupLabel } from './mappers';

// Treasurer Group Labels CRUD — JWT auth via the shared `api` instance (its
// interceptor attaches the Bearer token and does 401 refresh-and-retry). NOT the
// portal client. The backend scopes every endpoint to request.user.church, so no
// church-id is sent in any URL or body and no client-side church filter is applied.
//
// All write errors PROPAGATE (no swallow) so the screen can surface them — most
// importantly the backend archive-guard 400 ("Cannot archive a group with active
// campaigns."), which is the source of truth (a label's active count can change
// between the list refetch and the click).
export const groupsService = {
  // GET /group-labels/?archived=<bool> — the backend list is paginated
  // ({count,next,previous,results}); this returns just the mapped array (the screen
  // tracks the active vs archived view itself via the `archived` arg).
  async list(archived = false): Promise<GroupLabel[]> {
    const { data } = await api.get<PaginatedResponse<BackendGroupLabel>>(
      '/group-labels/',
      { params: { archived } },
    );
    return data.results.map(mapGroupLabel);
  },

  // POST /group-labels/ — the key conversion is parentLabelId → parent_label.
  // A flat label sends parent_label: null; a hierarchical one sends the parent id.
  async create({ name, parentLabelId }: { name: string; parentLabelId?: string }): Promise<GroupLabel> {
    const { data } = await api.post<BackendGroupLabel>('/group-labels/', {
      name,
      parent_label: parentLabelId ?? null,
    });
    return mapGroupLabel(data);
  },

  // PATCH /group-labels/{id}/ — rename only.
  async rename(id: string, name: string): Promise<GroupLabel> {
    const { data } = await api.patch<BackendGroupLabel>(`/group-labels/${id}/`, { name });
    return mapGroupLabel(data);
  },

  // POST /group-labels/{id}/archive/ — no body. A 400 (active campaigns exist)
  // PROPAGATES so the screen surfaces the backend detail message.
  async archive(id: string): Promise<GroupLabel> {
    const { data } = await api.post<BackendGroupLabel>(`/group-labels/${id}/archive/`);
    return mapGroupLabel(data);
  },

  // POST /group-labels/{id}/unarchive/ — no body.
  async unarchive(id: string): Promise<GroupLabel> {
    const { data } = await api.post<BackendGroupLabel>(`/group-labels/${id}/unarchive/`);
    return mapGroupLabel(data);
  },
};
