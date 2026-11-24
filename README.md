# MobileAppBackend — FawtraSmart Mobile API (Node.js + Express)

Backend for the FawtraSmart mobile app. It runs **on top of the existing FawtraSmart ERP database** (the Laravel web version) and mirrors the web's rules — same users, roles, permissions, application toggles and subscription plan — without duplicating data.

## Stack

- Node.js 20+, Express 4, TypeScript
- Knex (MySQL via `mysql2` in production, SQLite for local development)
- JWT access tokens + rotating refresh tokens stored in Laravel's `personal_access_tokens` (Sanctum table)
- bcrypt (`$2y$`, compatible with Laravel hashes), zod validation, helmet, rate limiting, pino logging
- In-memory cache (`node-cache`) for permissions, application settings, subscription snapshot, theme and languages

## Clean architecture layout

```
src/
  config/          env parsing (zod)
  domain/          entities, repository interfaces, pure services (ModuleCatalog, ThemePalette)
  application/     use cases, DTOs, ports (Cache, Hasher, TokenService, FileStorage), AccessService
  infrastructure/  knex connection, Knex repositories, MemoryCache, Bcrypt/JWT, file storage, logger
  interfaces/http/ express app, routes, controllers, middlewares (auth, validate, rate limit, errors)
  container.ts     manual dependency wiring
```

Dependencies always point inward: HTTP → application → domain. Infrastructure implements domain/application interfaces.

## Setup

```bash
cp .env.example .env   # fill DB_* with the same values as the ERP's .env
npm install
npm run dev            # tsx watch, http://localhost:4000
npm run build && npm start
npm test               # vitest
```

Key env vars: `DB_CLIENT` (`mysql2` or `sqlite`), `DB_*`, `JWT_SECRET`, `ERP_PUBLIC_URL` (used for logo/avatar URLs), `ERP_MEDIA_TOKEN` + optional `ERP_MEDIA_URL` (photos are uploaded to the ERP, see below).

## Endpoints (`/api/v1`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | – | liveness |
| GET | `/settings/theme` | – | colours/font from `color_sittings` (web "System appearance" screen) |
| GET | `/settings/languages` | – | active `system_languages` |
| POST | `/auth/login` | – | `{email, password, device}` → tokens + user. Same checks as `AuthController::login` (employee `allow_system_access`, archived profile), writes `last_login_*`, `logs`, `trusted_devices` |
| POST | `/auth/refresh` | – | rotate refresh token |
| POST | `/auth/logout` | Bearer | revoke refresh token (`everywhere: true` revokes all mobile sessions) |
| GET | `/auth/me` | Bearer | user + employee + branch + role + permissions |
| GET | `/home/modules` | Bearer | module cards visible to the user (see below) + subscription summary |
| GET | `/notifications` | Bearer | `?unread=true&last24h=true&page=1&perPage=20` |
| GET | `/notifications/unread-count` | Bearer | |
| POST | `/notifications/mark-read` | Bearer | `{ids: []}` |
| POST | `/notifications/mark-all-read` | Bearer | |
| GET | `/profile` | Bearer | user, switchable branches (`BranchScope` rules), employee points summary (`employee/profile` page) |
| PUT | `/profile` | Bearer | `{name, phone}` |
| PUT | `/profile/password` | Bearer | `{currentPassword, newPassword, newPasswordConfirmation}` – invalidates access tokens |
| PUT | `/profile/branch` | Bearer | `{branchId}` (null = all branches, needs `data_scope_all`) |
| POST | `/profile/avatar` | Bearer | multipart `avatar` (jpg/png/webp ≤ 5MB) |

### Accounting (`/accounting/*`, all need a Bearer token)

| Path | Section (permission) | Notes |
|---|---|---|
| `GET /accounting/sections` | – | the sidebar for this user's role, grouped like the web Account sidebar; locked (outside plan) items are flagged |
| `GET /accounting/overview?period=` | any `account.*` | only the figures the role may see |
| `GET /accounting/periods` | – | fiscal years / periods and the default |
| `GET /accounting/expenses` | `account.expenses.view` | `?page&perPage&search&period&state=active|reversed|all` |
| `GET /accounting/incomes` | `account.incomes.view` | `state=active|cancelled|all` |
| `GET /accounting/treasuries` | `account.treasury.view` | `kind=cash|bank`, `state=active|inactive` |
| `GET /accounting/journal-entries` | `account.journal.view` | `status=0|1` |
| `GET /accounting/chart-of-accounts` | `account.chart.view` | `type=asset|liability|expense|revenue` |
| `GET /accounting/cost-centers` | `account.cost_centers.view` | |
| `GET /accounting/payable-cheques`, `/received-cheques` | `account.payable_cheques.view`, `account.received_cheques.view` | `status=` |
| `GET /accounting/cheque-books` | `account.cheque_books.view` | |

Every section is checked exactly like the web: role permission, the application toggle
(`finance`, `general_accounts_journal_entries`, `cheque_cycle`) and the subscription plan
(`403 SECTION_FORBIDDEN` / `403 PLAN_LOCKED`). Lists are then scoped like the web screens:
**branch** (header branch and its subtree), **creator** (`data_scope_*` ladder: all → region → branch → department → team → own,
plus the manager's team), **accounting period** (defaults to the current fiscal year), and treasuries follow `treasury_employees`.
The logic lives in `application/services/DataScopeService.ts` and `PeriodResolver.ts`.

### Clients & field sales (`/clients`, `/itinerary`, `/visits`, `/visit-justifications`, `/tracking`, `/branches`)

A standalone TypeScript port of the web's client module (`Modules/Client` controllers, `ClientAccessService`, `DailyItineraryService`, `VisitWorkspaceController`, the model hooks they rely on): client list/map/detail/add/edit, status & stage requests, client contacts and follow-up notes, the daily itinerary, the full visit workspace (open → start → contact → shift → note → competitors → complete/cancel), forgotten visits, visit justifications, notification detail/reply and location tracking. Same permissions, same "who sees which client" cascade, same client-module settings, same tables. Writes use the ERP timezone (`APP_TIMEZONE`), the ERP's document numbering (`serial_settings`), and log to `logs` / `event_logs` / `error_logs` like the web.

- Endpoint tables: [`docs/CLIENTS_API_DOCUMENTATION.md`](docs/CLIENTS_API_DOCUMENTATION.md)
- Rules, flows, error codes and differences from the web: [`docs/CLIENTS_DETAILED_REFERENCE.md`](docs/CLIENTS_DETAILED_REFERENCE.md)
- Postman: [`docs/Clients.postman_collection.json`](docs/Clients.postman_collection.json)

Code lives under `*/clients/` in each layer (`domain/services/clients`, `application/services/clients`, `application/use-cases/clients`, `infrastructure/repositories/clients`, `interfaces/http/controllers/clients`, `interfaces/http/routes/clients.ts`). Photos are compressed here with `sharp` and **uploaded to the ERP** (`POST {ERP_MEDIA_URL}/api/mobile-media`, Laravel's `MobileMediaController`, shared secret `ERP_MEDIA_TOKEN` = `MOBILE_MEDIA_TOKEN` in the ERP's `.env`) into the web's own `public/` folders — nothing is stored on this server. The profile avatar uses the same path; `GOOGLE_MAPS_API_KEY` (optional) fills the neighborhood name; `ENFORCE_SUBSCRIPTION` mirrors the web's `FAWTRA_ENFORCE_SUBSCRIPTION`.

### Stock (`/stock/*`)

A standalone TypeScript port of the web's stock screens (`StorehouseController`, `WarehouseStatementController`, `StorePermitsManagementController`, `PriceListController` and the model hooks/observers they rely on): warehouses with their valuation and movements, the warehouse statement, warehouse permits of the four types (addition, disbursement, transfer, opening balance — numbered from `serial_settings`), approval and cancel-approval with the quantity moves, the journal entry (`AW-YYYY-NNNNN`, warehouse account auto-created under its parent) and the hierarchical balance recompute, and price lists. Same gates (subscription → `inventory_management` → plan feature → permission), same plan limits (`warehouse_permits`, `journal_entries`, `price_lists`), same accounting-period guard, same warehouse/creator scope.

- Endpoint tables: [`docs/STOCK_API_DOCUMENTATION.md`](docs/STOCK_API_DOCUMENTATION.md)
- Rules, flows, error codes and differences from the web: [`docs/STOCK_DETAILED_REFERENCE.md`](docs/STOCK_DETAILED_REFERENCE.md)
- Postman: [`docs/Stock.postman_collection.json`](docs/Stock.postman_collection.json)

Code lives under `*/stock/` in each layer. Permit attachments (JPEG/PNG/PDF ≤ 5 MB) go to the ERP through the same `mobile-media` endpoint (folder `assets/uploads/warehouse`). The ERP migration `2026_09_27_000001_add_stock_lookup_indexes` must be run on the ERP (`php artisan migrate`) — without it the warehouse details and permit logs scan whole tables.

### Sales (`/sales/*`)

A standalone TypeScript port of the web's sales controllers (`InvoicesController`, `SalesPaymentController`, `ReturnInvoiceController`, `CreditNotificationController`, `ProductExchangeController`, `QuoteController` / `SalesOrderController`, `DailyClosingController`, `WeeklyCommissionController`, `PaymentsByEmployeeController`): invoices (stock out, SI + cost entries, advance receipt, credit balance and wallet settlement, offers, gifts, coupons, credit limits, proximity), collections (single and bulk), returns, credit notes (settlement and cancel), product exchanges, quotes and sales orders with conversion through the invoice engine, daily closing, the rep's own targets and commissions, and payments by employee. Same gates (subscription → `sales` → plan feature → permission), same usage limits (`sales_invoices`, `sales_payments`, `return_invoices`, `credit_notes`, `product_exchanges`, `quotes`, plus `warehouse_permits` / `journal_entries` / `internal_notifications`), same accounting accounts and document numbering. Web bugs are fixed here, not in the web — each one is listed in the detailed reference.

- Endpoint tables: [`docs/SALES_API_DOCUMENTATION.md`](docs/SALES_API_DOCUMENTATION.md)
- Rules, differences from the web, what is not ported: [`docs/SALES_DETAILED_REFERENCE.md`](docs/SALES_DETAILED_REFERENCE.md)
- Postman: [`docs/Sales.postman_collection.json`](docs/Sales.postman_collection.json)

Code lives under `*/sales/` in each layer (shared accounting in `application/services/accounting/`). Exchange photos go to the ERP through `mobile-media` (folder `uploads/product_exchanges`, allowed in `MobileMediaController::FOLDERS`).

Responses are `{ success: true, data }` or `{ success: false, error: { code, message, details? } }`. Error codes (`INVALID_CREDENTIALS`, `EMPLOYEE_ACCESS_DENIED`, `TOKEN_EXPIRED`, …) are translated by the app.

## How module cards are decided

`src/domain/services/ModuleCatalog.ts` is a literal copy of the tiles in the web header (`resources/views/layouts/header.blade.php`) with their permission gates, linked to the keys of `ApplicationRegistry` and `ApplicationPlanFeatures`. A card is shown when all three hold, exactly like the web:

1. the user's role (`users.role_id` → `role_has_permissions`) passes the tile's permission gate;
2. the module is active in `application_settings` (unsaved key = active);
3. the subscription plan permits at least one of the module's features — otherwise the card is returned with `locked: true, lockReason: 'plan'`.

## Security notes

- Passwords are verified with bcrypt against the existing `users.password` column; new hashes are written with the `$2y$` prefix so the web keeps working.
- Access tokens carry a password-version fingerprint; changing the password revokes them.
- Login is rate limited (20 / 15 min / IP), the whole API at 240 req/min, location sending (`POST /tracking/location`) at 30 / min / user like the web's `throttle:30,1`.
