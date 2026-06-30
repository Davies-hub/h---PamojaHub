import { DashboardStats } from '../types';
import { api } from './api';
import { BackendDashboardStats, mapDashboardStats } from './mappers';

export const dashboardService = {
  // Authed: GET /churches/me/stats/ — the request interceptor attaches the Bearer
  // token; the backend scopes everything to request.user.church. Returns the four
  // headline numbers (NET) + the recent-donations feed.
  async getStats(): Promise<DashboardStats> {
    const { data } = await api.get<BackendDashboardStats>('/churches/me/stats/');
    return mapDashboardStats(data);
  },
};
