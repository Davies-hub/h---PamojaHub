# PamojaHub Audit — INVENTORY (Phase 0 grounding)

> What actually exists. All later phases test against THIS, never from memory.
> Compiled session 1 (2026-06-24) by static read. Endpoints to be wire-confirmed in Phase 0.5+.

---

## A. FRONTEND (frontend/ — Expo SDK 56 / React Native web)

### A.1 Routes / screens (app/, Expo Router file-based)

**(public)/** — no auth
- `index.tsx` — landing
- `campaigns/index.tsx` — browse campaigns
- `campaigns/[slug].tsx` — campaign detail + DonationForm
- `churches/index.tsx` — browse churches
- `churches/[id].tsx` — church profile
- `treasurer/index.tsx` — Campaign-Treasurer OTP portal (phone→OTP→scoped view) **[imports mockTreasurerProfile]**

**(auth)/** — Stack, headerShown:false
- `login.tsx`, `register.tsx`, `reset-password.tsx`

**(treasurer)/** — Tabs, auth-gated (JWT, role CHURCH_TREASURER)
- `index.tsx` — Overview
- `campaigns/index.tsx`, `campaigns/new.tsx` **[imports mockGroupLabels]**, `campaigns/[slug].tsx`, `campaigns/_layout.tsx`
- `payouts.tsx`, `reports.tsx`, `settings.tsx`
- hidden: `notifications.tsx`, `groups.tsx`

**(super)/** — Tabs, auth-gated (JWT, role SUPER_ADMIN)
- `index.tsx` (Queue), `churches.tsx`, `withdrawals.tsx`, `analytics.tsx`, `billing.tsx`, `more.tsx`
- hidden: `campaigns.tsx`, `donations.tsx`, `audit-log.tsx`

Root: `app/_layout.tsx`, `+not-found.tsx`. Plus SubscriptionCard inside treasurer settings.

### A.2 Reusable components (components/)
- ui/: Button, Input, Badge, Card, Modal, Spinner, Toast, ProgressBar, BrandLogo, OTPInput, CountyPicker
- campaign/: CampaignCard, CampaignCreationForm, DonationForm, WhatsAppShareButton
- layout/: TopNav, NotificationBell, TreasurerSidebar, SuperAdminSidebar
- disbursement/: DisbursementRequestForm (⚠ flagged empty in CLAUDE — Phase 7), DisbursementApprovalDialog
- treasurer/: SubscriptionCard
- OfflineScreen.tsx

### A.3 services/*.ts → endpoint + verb (the contract boundary)

| Service.method | Verb | Path | Client | Notes |
|---|---|---|---|---|
| auth.login | POST | /auth/login/ | api | returns {access,refresh,user} |
| auth.getCurrentUser | GET | /auth/me/ | api | session restore |
| auth.register | POST | /auth/register/ | api | mapRegisterPayload |
| auth.logout | POST | /auth/logout/ | api | sends {refresh} |
| auth.requestPasswordReset | — | (stubbed `// Phase 4`) | — | **NOT wired** |
| auth.confirmPasswordReset | — | (stubbed `// Phase 4`) | — | **NOT wired** |
| campaigns.browse | GET | /campaigns/ | api | Paginated |
| campaigns.listMine | GET | /campaigns/mine/ | api | Paginated |
| campaigns.getMineBySlug | GET | /campaigns/mine/{slug}/ | api | |
| campaigns.getBySlug | GET | /campaigns/{slug}/ | api | public detail |
| campaigns.pause | POST | /campaigns/mine/{slug}/pause/ | api | |
| campaigns.resume | POST | /campaigns/mine/{slug}/resume/ | api | |
| campaigns.close | POST | /campaigns/mine/{slug}/close/ | api | |
| churches.browse | GET | /churches/ | api | Paginated |
| churches.getById | GET | /churches/{id}/ | api | |
| churches.getMyChurch | GET | /churches/me/ | api | |
| churches.updateMyChurch | PATCH | /churches/me/ | api | |
| churches.listMyDonations | GET | /churches/me/donations/ | api | Paginated |
| dashboard.getStats | GET | /churches/me/stats/ | api | |
| donations.initiate | POST | /donations/initiate/ | api | STK push |
| donations.getStatus | GET | /donations/{id}/status/ | api | poll |
| donations.listForCampaign | — | (stubbed) + imports mockDonations | — | **mock** |
| groups.list | GET | /group-labels/ | api | Paginated |
| groups.create | POST | /group-labels/ | api | |
| groups.rename | PATCH | /group-labels/{id}/ | api | |
| groups.archive | POST | /group-labels/{id}/archive/ | api | |
| groups.unarchive | POST | /group-labels/{id}/unarchive/ | api | |
| notifications.list | GET | /notifications/ | api | Paginated |
| notifications.unreadCount | GET | /notifications/unread-count/ | api | |
| notifications.markRead | POST | /notifications/{id}/read/ | api | |
| notifications.markAllRead | POST | /notifications/read-all/ | api | |
| subscriptions.initiate | POST | /subscriptions/initiate/ | api | STK |
| subscriptions.getStatus | GET | /subscriptions/{id}/status/ | api | poll |
| subscriptions.cancel | POST | /subscriptions/cancel/ | api | |
| superadmin.getBilling | GET | /super/billing/ | api | |
| superadmin.updateFeePercent / saveGrowthPrice / saveParishPrice | PATCH | /super/billing/ | api | 3 methods, same endpoint |
| superadmin.listWithdrawals | GET | /super/withdrawals/ | api | Paginated |
| superadmin.listCampaigns | GET | /super/campaigns/ | api | Paginated |
| superadmin.listDonations | GET | /super/donations/ | api | Paginated |
| superadmin.listPendingChurches | GET | /super/churches/pending/ | api | Paginated |
| superadmin.listChurches | GET | /super/churches/ | api | Paginated |
| superadmin.getAnalytics | GET | /super/analytics/ | api | single object |
| superadmin.listAuditLog | GET | /super/audit-log/ | api | Paginated |
| superadmin.forceRetry | POST | /super/withdrawals/{id}/force-retry/ | api | |
| superadmin.resolvePaid | POST | /super/withdrawals/{id}/resolve-paid/ | api | |
| superadmin.resolveRetry | POST | /super/withdrawals/{id}/resolve-retry/ | api | |
| superadmin.rejectChurch | POST | /super/churches/{id}/reject/ | api | {rejection_reason} |
| superadmin.approveChurch | POST | /super/churches/{id}/approve/ | api | |
| superadmin.suspendChurch | POST | /super/churches/{id}/suspend/ | api | |
| superadmin.reactivateChurch | POST | /super/churches/{id}/reactivate/ | api | |
| superadmin.setTier | POST | /super/churches/{id}/set-tier/ | api | |
| treasurer-portal.requestOtp | POST | /treasurer/request-otp/ | api | {phone_number} |
| treasurer-portal.verifyOtp | POST | /treasurer/verify-otp/ | api | returns portal token |
| treasurer-portal.(donations) | GET | /treasurer/campaigns/{id}/disbursements/ | **portalClient** | uses bare portal client |
| treasurer-portal.(request-disbursement) | POST | /treasurer/campaigns/{id}/request-disbursement/ | **portalClient** | |
| withdrawals.list | GET | /withdrawals/ | api | Paginated |
| withdrawals.approve | POST | /withdrawals/{id}/approve/ | api | |
| withdrawals.reject | POST | /withdrawals/{id}/reject/ | api | {reason} |
| withdrawals.retry | POST | /withdrawals/{id}/retry/ | api | |

⚠ Note: superadmin.reactivateChurch calls `/super/churches/{id}/reactivate/` — backend route is `reactivate/` (matches). FE earlier docs said "reinstate"; confirm naming in Phase 5.

### A.4 Mappers (services/mappers.ts — snake→camel + decimal→Number boundary)
mapUser, mapRegisterPayload, mapPublicCampaign, mapPublicChurch, mapRecentDonation, mapDashboardStats, mapTreasurerCampaign, mapWithdrawal, mapGroupLabel, mapPlatformSettings, mapAdminChurch, mapMyChurch, toMyChurchUpdateRequest, mapPortalCampaign, mapPortalDonation, mapMyDonation, mapDonation, mapDonorStatus, mapSubscriptionStatus, mapAnalytics, mapAuditLog.
Plus pure helpers: utils/subscription.ts (pollReducer), hooks/useFocusRefetch.ts.

### A.5 api client (services/api.ts)
- `api` axios instance, baseURL `EXPO_PUBLIC_API_URL || http://localhost:8000/api/v1`, timeout 30s.
- Request interceptor attaches `Authorization: Bearer <accessTokenCache>` (in-memory cache).
- Response interceptor: single-flight refresh-and-retry on 401 (`_retried` loop guard → forceLogout). Refresh uses bare axios (no interceptor re-entry).
- `portalClient.ts` — separate bare client for portal-token calls (X-Portal-Token / Authorization: Portal).
- Forced-logout bridge to auth store.

### A.6 Mock files (mock/) and CURRENT import status
- `treasurer.mock.ts` — **STILL IMPORTED** by (public)/treasurer/index.tsx (mockTreasurerProfile) + tests
- `groups.mock.ts` — **STILL IMPORTED** by (treasurer)/campaigns/new.tsx (mockGroupLabels)
- `donations.mock.ts` — **STILL IMPORTED** by donations.service.ts (mockDonations, listForCampaign stub)
- `campaigns.mock.ts` — imported only by tests/mockDataConsistency.test.ts → **orphaned in app** (Phase 7)
- `churches.mock.ts` — tests only → **orphaned** (Phase 7)
- `withdrawals.mock.ts` — tests only → **orphaned** (Phase 7)
- `notifications.mock.ts` — no app/test import found → **orphaned** (Phase 7, re-verify)
- `auditlog.mock.ts` — no app/test import found → **orphaned** (Phase 7, re-verify)

---

## B. BACKEND (backend/ — Django 5 + DRF + PostgreSQL)

### B.1 Apps
audit, accounts, churches, campaigns, donations, withdrawals, notifications, treasurer_portal, superadmin, integrations, common. (INSTALLED_APPS lists all except `integrations`/`common` which are libs, not Django apps — confirm in base.py: integrations/common NOT in INSTALLED_APPS — they have no models/migrations, code-only.)

### B.2 Models (+ key enums)
- accounts: `User` (custom, AUTH_USER_MODEL), `UserRole`(TextChoices), `RefreshToken`, `PasswordResetOTP`
- churches: `Church`, `ChurchStatus`(PENDING/ACTIVE/SUSPENDED/REJECTED), `SubscriptionTier`(FREE/GROWTH/PARISH), `SubscriptionPayment`, `SubscriptionPaymentStatus`
- campaigns: `Campaign`, `CampaignStatus`(ACTIVE/PAUSED/CLOSED), `CampaignCategory`, `GroupLabel`, `CampaignUpdate`
- donations: `Donation`, `DonationStatus`
- withdrawals: `Withdrawal`, `WithdrawalStatus`(PENDING_APPROVAL/PROCESSING/PAID/FAILED/FAILED_FINAL/REJECTED/NEEDS_RECONCILIATION), `WithdrawalDispatchOutcome`
- notifications: `Notification`, `NotificationType`
- treasurer_portal: `CampaignTreasurerOTP`, `PortalToken`
- superadmin: `PlatformSettings` (singleton)
- audit: `AuditLog`

### B.3 Serializers (field-level allowlists read on demand in Phase 1.3 / 3.3)
- accounts: LoginSerializer, PasswordResetRequestSerializer, PasswordResetConfirmSerializer, UserSerializer
- churches: ChurchRegistrationSerializer, PublicChurchSerializer, AdminChurchSerializer, SubscriptionInitiateSerializer
- campaigns: PublicCampaignSerializer, AdminCampaignSerializer (WRITE/create-edit), SuperCampaignSerializer (read), GroupLabelSerializer, CampaignUpdateSerializer
- donations: DonationInitiateSerializer, DonationStatusSerializer, AdminDonationSerializer, PortalDonationReportSerializer
- withdrawals: WithdrawalSerializer, WithdrawalRequestSerializer
- treasurer_portal: OTPRequestSerializer, OTPVerifySerializer, PortalCampaignSerializer
- notifications: NotificationSerializer
- audit: AuditLogSerializer

Serializer split = SECURITY boundary: public = strict allowlist; admin/super = wider. Phase 3.3 verifies no internal field (checkout_request_id, b2c_conversation_id, raw FKs, gross/fee on church surfaces, PII) leaks.

### B.4 Views + permission_classes (from grep)
- **AllowAny:** donations (initiate L78, callback L190, status L278), campaigns public list L138/detail L176, accounts (register L114, login L200, ?L238 token-refresh, password-reset request L323/confirm L377), churches public list L94/detail L124, churches L532 (subscription callback), treasurer_portal request-otp L102/verify-otp L187, withdrawals L633 (B2C result callback)
- **IsAuthenticated:** accounts MeView L299, accounts L447 (logout), notifications (all 4)
- **IsChurchTreasurer:** campaigns mine-list L209/L214, churches me/stats/donations (L193/L197/L269/L273), churches L339/L473/L635 (subscription initiate/cancel/status?), withdrawals list L147/L157
- **ChurchNotSuspended:** campaigns create/state-change L254/L261
- **ChurchNotSuspended + ChurchScopedPermission:** withdrawals approve/reject/retry (L222/L230/L381/L384/L460/L463)
- **HasValidPortalToken:** treasurer_portal L260/L277/L327/L464
- **IsSuperAdmin:** ALL superadmin views (L127…L946)

### B.5 Management commands
- withdrawals/: `sweep_stranded_withdrawals` (escalate-only), `cleanup_synthetic_withdrawals` (dev-only guarded)
- donations/: `sweep_stranded_donations`
- churches/: `process_subscriptions` (reminders + lapse), `set_subscription_expiry` (DEBUG-gated dev clock)
- Celery wired (config/celery.py) but web/tests never connect.

### B.6 Rate-limiting / throttle posture
- **NO DRF DEFAULT_THROTTLE_CLASSES** and no `throttle_classes` on any view. Rate limiting is via **django-ratelimit** decorators only (selective per-view).
- `common/ratelimit_keys.py::normalized_phone_key` — normalizes phone before keying (closes format-variant budget-multiplication on OTP/verify).
- Dev cache = LocMemCache (`RATELIMIT_USE_CACHE='default'` set in development.py only).
- **LEAD (Phase 1.7/2.5):** production.py defines NO CACHES and NO RATELIMIT_USE_CACHE → prod would fall back to LocMemCache (per-process) → rate limits not shared across gunicorn workers → weakened brute-force/SMS ceiling. Confirm which endpoints carry @ratelimit (login? reset? donation initiate? otp?).

### B.7 Config posture (settings/)
- Split package: base.py / development.py / production.py. DJANGO_SETTINGS_MODULE to confirm at boot (0.5).
- DEBUG: base default False; development.py True; production.py False.
- REST_FRAMEWORK: JWTAuthentication default; IsAuthenticated default perm; StandardPagination (PAGE_SIZE 20); custom exception handler `common.exceptions.custom_exception_handler`.
- SIMPLE_JWT: access 60min, refresh 7d, ROTATE_REFRESH_TOKENS True, BLACKLIST_AFTER_ROTATION True. **LEAD:** `rest_framework_simplejwt.token_blacklist` NOT in INSTALLED_APPS → SimpleJWT's own blacklist inert; rotation/replay handled by custom accounts.RefreshToken — verify in Phase 1.1.
- CORS: CORS_ALLOWED_ORIGINS from env list (default []); CORS_ALLOW_CREDENTIALS True. Confirm actual origins + no wildcard (Phase 2.5).
- **LEAD (Phase 2.5):** production.py has NO security headers (SSL redirect, HSTS, secure cookies, X-Frame, SECURE_PROXY_SSL_HEADER) — comment defers to "deployment". Flag as config gap.
- `_client_ip` = REMOTE_ADDR only (no XFF parsing) → behind a prod proxy, portal IP-binding + ip ratelimits key on the proxy IP. Acknowledged in code; flag (Phase 1.4).
- Externals stubbed suite-wide via `config.test_runner.StubbedExternalsTestRunner`.
- PLATFORM_FEE_PERCENT setting = 2.5 but per CLAUDE rule the LIVE fee is read from PlatformSettings at callback (PLATFORM_FEE_PERCENT is a decoy) — verify (Phase 2.1).

---

## C. API SURFACE — full contract table (perm + pagination; req/resp shapes resolved per-phase)

> Paginated = StandardPagination D5 `{items,total,truncated}` for super lists, or DRF `{count,results}` for notifications/others — exact shape verified in Phase 3.2/5.1.

### /api/v1/auth/
| Method | Path | Perm |
|---|---|---|
| POST | register/ | AllowAny |
| POST | login/ | AllowAny |
| GET | me/ | IsAuthenticated |
| POST | token/refresh/ | AllowAny |
| POST | logout/ | IsAuthenticated |
| POST | password-reset/request/ | AllowAny |
| POST | password-reset/confirm/ | AllowAny |

### /api/v1/treasurer/ (portal — phone/OTP, no JWT)
| POST | request-otp/ | AllowAny (@ratelimit) |
| POST | verify-otp/ | AllowAny (MAX_ATTEMPTS=5) |
| GET | campaigns/ | HasValidPortalToken |
| GET | campaigns/{id}/report/ | HasValidPortalToken |
| POST | campaigns/{id}/request-disbursement/ | HasValidPortalToken |
| GET | campaigns/{id}/disbursements/ | HasValidPortalToken |

### /api/v1/churches/
| GET | (list) | AllowAny | Paginated |
| GET | me/ | IsChurchTreasurer |
| GET | me/stats/ | IsChurchTreasurer |
| GET | me/donations/ | IsChurchTreasurer | Paginated |
| GET | {id}/ | AllowAny |
| PATCH | me/ | IsChurchTreasurer (ChurchNotSuspended? confirm) |

### /api/v1/campaigns/
| GET | (list) | AllowAny | Paginated |
| GET | mine/ | IsChurchTreasurer | Paginated |
| POST | mine/create/ | ChurchNotSuspended |
| GET | mine/{slug}/ | IsChurchTreasurer |
| POST | mine/{slug}/pause/ | ChurchNotSuspended (+Scoped) |
| POST | mine/{slug}/resume/ | ChurchNotSuspended (+Scoped) |
| POST | mine/{slug}/close/ | ChurchNotSuspended (+Scoped) |
| GET/POST | {slug}/updates/ | AllowAny GET / treasurer POST |
| GET | {slug}/ | AllowAny |

### /api/v1/group-labels/
| GET,POST | (list/create) | IsChurchTreasurer / ChurchNotSuspended |
| PATCH | {id}/ | ChurchNotSuspended (+Scoped) |
| POST | {id}/archive/ | ChurchNotSuspended (+Scoped) |
| POST | {id}/unarchive/ | ChurchNotSuspended (+Scoped) |

### /api/v1/withdrawals/
| GET | (list) | IsChurchTreasurer | Paginated |
| POST | b2c-result/ | AllowAny (Safaricom callback) |
| POST | {id}/approve/ | ChurchNotSuspended + Scoped |
| POST | {id}/reject/ | ChurchNotSuspended + Scoped |
| POST | {id}/retry/ | ChurchNotSuspended + Scoped |

### /api/v1/super/ (ALL IsSuperAdmin)
| GET | churches/ | Paginated |
| GET | churches/pending/ | Paginated |
| GET | campaigns/ | Paginated |
| GET | donations/ | Paginated |
| GET | withdrawals/ | Paginated |
| GET | analytics/ | object |
| GET | audit-log/ | Paginated |
| POST | churches/{id}/approve/ | |
| POST | churches/{id}/reject/ | |
| POST | churches/{id}/suspend/ | |
| POST | churches/{id}/reactivate/ | |
| POST | churches/{id}/set-tier/ | |
| POST | withdrawals/{id}/force-retry/ | money-mover |
| POST | withdrawals/{id}/resolve-paid/ | |
| POST | withdrawals/{id}/resolve-retry/ | |
| GET,PATCH | billing/ | |

### /api/v1/donations/ (ALL AllowAny)
| POST | initiate/ | @ratelimit (per CLAUDE: 10/h per phone — confirm) |
| POST | callback/ | Safaricom STK |
| GET | {id}/status/ | poll (GROSS) |

### /api/v1/subscriptions/
| POST | initiate/ | IsChurchTreasurer |
| POST | cancel/ | IsChurchTreasurer |
| POST | callback/ | AllowAny (Safaricom) |
| GET | {id}/status/ | IsChurchTreasurer (confirm) |

### /api/v1/notifications/ (ALL IsAuthenticated, recipient-scoped)
| GET | (list) | Paginated {count,results} |
| GET | unread-count/ | {count} |
| POST | read-all/ | {updated} |
| POST | {id}/read/ | idempotent, foreign→404 |

---

## D. KNOWN LEADS carried into later phases (not yet findings)
1. Prod ratelimit cache = per-process LocMemCache (no Redis in production.py) — weakens shared brute-force/SMS ceiling. [1.7/2.5]
2. token_blacklist app absent though BLACKLIST_AFTER_ROTATION=True — verify custom refresh rotation actually revokes old refresh. [1.1]
3. _client_ip = REMOTE_ADDR only — proxy collapses portal IP-binding + ip ratelimits. [1.4]
4. production.py has no security headers / secure cookies / HSTS. [2.5]
5. Empty/dead DisbursementRequestForm.tsx; 5 orphaned mock files. [7]
6. donations.service.listForCampaign still mock; (public)/treasurer + campaigns/new still import mocks. [4.5/7]
7. password-reset FE service is still a `// Phase 4` stub though backend endpoints exist — contract drift. [5.4]
8. Confirm which auth endpoints carry @ratelimit (login/reset may have none → brute-force). [1.7]
