# BuildSite — Construction Material Request & Inventory Management System

Production-grade monorepo: **React Native (Expo Router)** mobile client + **NestJS + Prisma (PostgreSQL)** backend.

```text
/workspace
├── mobile/          # Expo (SDK 51) + TypeScript strict + Expo Router + TanStack Query + Zustand + NativeWind (custom tokens)
└── server/          # NestJS + Prisma + PostgreSQL + JWT/Refresh rotation + RBAC guards + Smart Approval Engine + Photo Moderation
```

## Security model (server-authoritative)
- **Approval routing** is computed *only* in `ApprovalEngineService` (cost vs. delegated limit, criticality, role of requester). Clients submit line items; the server re-prices from the DB catalog.
- **Inventory deduction** happens atomically inside a serializable Prisma transaction on approval/issue — never on the client.
- **Photo moderation**: uploads get a presigned S3 URL with enforced content-type/size; metadata lands as `PENDING_REVIEW`; visibility rules are applied by `PhotoVisibilityService` in every query (`where` clause, not UI filtering).
- **Tokens**: access (15 min) + rotating refresh (7 days, hashed at rest, revocable per session) stored in `expo-secure-store`. Biometric unlock via `expo-local-authentication` gates the app, not the API.
- **Rate limiting** (`@nestjs/throttler`) on OTP/auth endpoints; audit trail on every state transition.

## Quick start

### Backend
```bash
cd server
cp .env.example .env      # fill DATABASE_URL, JWT_SECRET, AWS_* , FCM_*
npm install
npx prisma migrate dev    # schema + enums + role matrix
npm run seed              # demo roles/limits/catalog (seed data for provisioning, not mock API responses)
npm run start:dev
```

### Mobile
```bash
cd mobile
cp .env.example .env      # EXPO_PUBLIC_API_URL=https://api.yourdomain.com
npm install
npx expo start            # builds against real endpoints; no mocked responses in src/
```

## Feature → module map
| Requirement | Server | Mobile |
|---|---|---|
| OTP login / biometrics / refresh rotation | `src/auth/*` | `hooks/useAuth.ts`, `store/authStore.ts`, `services/secureStorage.ts` |
| RBAC (Worker/Client/Admin/Staff/Accounts) | `common/guards/roles.guard.ts`, `enums.role` | `theme.config.ts` role nav map, route groups `(tabs)/{worker,client,admin,staff,accounts}` |
| Photo moderation queue | `src/photos/*` (presign, review actions, archival cron) | `features/photo/*`, `components/ui/MediaThumbnail.tsx` |
| Smart approval engine | `src/requests/approval-engine.service.ts` | read-only status UI (`SmartButton` disabled states) |
| Offline-first queue | idempotency-key header support on `POST /requests` | `offline/*` (SQLite queue + sync worker + conflict re-fetch) |
| Design system | — | `config/theme.config.ts`, `components/ui/*` (GlassCard, StatusBadge, SmartButton, MediaThumbnail, TimelineItem) |
