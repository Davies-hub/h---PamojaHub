import { AuthUser } from '../types';

// THE single auth-routing decision — used by BOTH the login screen and the
// session-restore guard (root layout) so the two can never diverge:
//   - SUPER_ADMIN           → super dashboard
//   - ACTIVE treasurer      → treasurer dashboard
//   - non-ACTIVE treasurer  → '/login' (the login screen shows the church-status
//                             message; a PENDING/REJECTED/SUSPENDED church must not
//                             land in a dashboard that assumes ACTIVE)
//   - no user               → null (no forced destination; public/auth routes allowed)
export type AuthDestination = '/(super)/' | '/(treasurer)/' | '/login';

export function resolveAuthDestination(user: AuthUser | null): AuthDestination | null {
  if (!user) return null;
  if (user.role === 'SUPER_ADMIN') return '/(super)/';
  // CHURCH_TREASURER
  return user.churchStatus === 'ACTIVE' ? '/(treasurer)/' : '/login';
}
