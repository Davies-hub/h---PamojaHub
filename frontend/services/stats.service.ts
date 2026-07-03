import { PlatformTotals } from '../types';
import { api } from './api';
import { BackendPlatformTotals, mapPlatformTotals } from './mappers';

export const statsService = {
  // Public: GET /stats/ — all-time platform totals for the landing hero. No auth
  // (AllowAny backend). Server computes every figure; total_raised is a decimal
  // STRING on the wire, converted to Number in mapPlatformTotals.
  async getPlatformTotals(): Promise<PlatformTotals> {
    const { data } = await api.get<BackendPlatformTotals>('/stats/');
    return mapPlatformTotals(data);
  },
};
