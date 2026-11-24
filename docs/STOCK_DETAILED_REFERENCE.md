# FawtraSmart Mobile Backend (Node) — Stock — Detailed Reference

The inventory part of the FawtraSmart mobile API served by the Node.js/Express backend in `MobileAppBackend/`: warehouses (read only), the warehouse statement, warehouse permits of the four manual types (addition, disbursement, transfer, opening balance) with their approval cycle, and price lists. It runs against the **same MySQL database as the ERP** (Laravel) and writes the same rows the web writes — `warehouse_permits`, `warehouse_permits_products`, `product_details`, `journal_entries`, `journal_entry_details`, `accounts`, `price_lists`, `price_list_items`, `logs`, `notifications`.

| | |
|---|---|
| **Base URL** | `{{base_url}}/api/v1/` (default local `http://localhost:4000`) |
| **Format** | JSON in / JSON out. Every error — including unknown routes — is JSON |
| **Uploads** | `POST stock/permits` and `PUT/POST stock/permits/{id}` accept JSON **or** `multipart/form-data` (only needed for the optional `attachments` file) |
| **Auth** | `Authorization: Bearer {accessToken}` from `POST /api/v1/auth/login` (JWT, `JWT_ACCESS_TTL`, default 1 h; renew with `POST /api/v1/auth/refresh`) |
| **Field names** | camelCase in queries, bodies and responses (`permissionType`, `warehouseId`, `unitPrice`, `salePrice` …) |
| **Language** | Arabic messages (the web's own messages where one exists) |
| **Permissions** | The same permission names as the matching web / integration route (`permission.role:` on the web), read from the user's primary role (`users.role_id` → `role_has_permissions`) |

**List URLs shared with the stock section screens:** `GET stock/warehouses` and `GET stock/permits` are served by the stock section screens (registered first): query `page, perPage (≤50), search, status`, response `{ items, total, page, perPage }`. Details (`/{id}`), the statement and every write stay on this port.

## Contents

1. [Implementation principle](#implementation-principle--a-standalone-typescript-port)
2. [Response shape and error codes](#response-shape-and-error-codes)
3. [Gates](#gates)
4. [Data scope — who sees what](#data-scope--who-sees-what)
5. [Settings that change behaviour](#settings-that-change-behaviour)
6. [Time, numbers, logs and notifications](#time-numbers-logs-and-notifications)
7. [The permit cycle](#the-permit-cycle)
8. [Uploads](#uploads)
9. [Endpoint index](#endpoint-index)
10. [Warehouses](#1-warehouses)
11. [Warehouse statement](#2-warehouse-statement)
12. [Permits](#3-permits)
13. [Approval](#4-approval)
14. [Price lists](#5-price-lists)
15. [Deliberate differences from the web](#deliberate-differences-from-the-web)
16. [Web fixes made during the port](#web-fixes-made-during-the-port)
17. [Developer notes](#developer-notes)

---

## Implementation principle — a standalone TypeScript port

Nothing here calls Laravel. The Laravel integration copy (`Modules/Integration/routes/api/stock.php`, `Modules/Integration/Http/Controllers/Api/Stock/*`) answers by **delegating** to the web controllers; the Node API instead **re-implements** those web controllers step by step in TypeScript — same order of checks, same rules, same permission names, same plan features and limits, same Arabic messages — and writes directly to the shared ERP tables through Knex. Model hooks the web relies on are re-implemented where the write happens: `PlanLimitObserver` (plan limits inside the transaction), `StockMovementGuardObserver` (no stock row for service/digital products), `JournalEntry` owner/period stamping, `JournalEntryDetail::created` → `Account::updateParentBalances()`.

Layers (clean architecture):

| Layer | Stock code |
|---|---|
| Routes | `src/interfaces/http/routes/stock.ts` (mounted under `/api/v1` by `routes/index.ts`) |
| Controllers (query schemas, status codes, response wrapper) | `src/interfaces/http/controllers/stock/WarehousesController.ts`, `PermitsController.ts`, `PriceListsController.ts` (shared `parseQuery` / `idParam` / `uploadedFiles` from `controllers/clients/ClientsController.ts`, `calendarDate` from `schemas.ts`) |
| Use cases (permissions, validation, business rules, response shapes) | `src/application/use-cases/stock/` — `WarehouseUseCases`, `PermitUseCases`, `PermitApprovalUseCases`, `PriceListUseCases` |
| Shared application services | `src/application/services/stock/` — `StockContext` (+ `StockContextFactory`: gates and per-request scope), `AccountingPeriodGuard`, `AccountBalances`, `StockLog`; `src/application/services/access/` — `ErpGate`, `PlanLimitGuard`; `PeriodResolver` |
| Domain constants | `src/domain/services/stock/StockConstants.ts` — permission sources, permit types, stored statuses, plan features, module key |
| Infrastructure | `src/infrastructure/repositories/stock/` — `KnexStockRepository`, `KnexPermitRepository` (+ `KnexPeriodGuardRepository`, `KnexUsageCounter`), `KnexApprovalRepository` (+ `KnexLedgerRepository`), `KnexPriceListRepository`; `src/infrastructure/storage/ErpImageStore.ts` (`saveDocument`) |

Web source of each area:

| Node use case | Web source (`Modules\Stock\Http\Controllers\…`) | Integration copy |
|---|---|---|
| `WarehouseUseCases` — list / show / movements | `Stock\StorehouseController` — `index` (+ `buildStorehouseListMeta()`), `show` (`buildAccountingOverview()`), `searchSummaryInventoryOperations()` | `Api\Stock\WarehouseController` |
| `WarehouseUseCases` — statement | `Reports\WarehouseStatementController` — `generateStatement()`, `calculateOpeningBalance()`, `reportDateRange()` | `Api\Stock\StatementController` |
| `PermitUseCases` | `Stock\StorePermitsManagementController` — `index`, `show`, `create` / `manual_disbursement` / `manual_conversion` / `opening_balance`, `getProductStock`, `store` (`WarehousePermitsRequest`), `update`, `delete`, `reject` | `Api\Stock\PermitController` |
| `PermitApprovalUseCases` | `Stock\StorePermitsManagementController` — `approve` (`createApprovalJournalEntry()`, `updateAccountBalances()`, `closeAdjustmentIfSettled()`), `cancelApproval` (`createReverseJournalEntries()`) | `Api\Stock\PermitController` |
| `PriceListUseCases` | `Stock\PriceListController` — `index`, `show`, `store`, `update`, `destroy`, `addProduct`, `removeProduct`; `scopeToProductVisibility()` | `Api\Stock\PriceListController` |
| `StockContext` | `ScopesToEmployeeHierarchy`, `StorehouseAccess`, `DataScope` | — |
| `AccountingPeriodGuard` | `RespectsAccountingPeriods::accountingPeriodBlock()`, `AccountingPeriodService::check()` | — |
| `PlanLimitGuard` | `SubscriptionGate::checkLive()` (`plan.limit:` middleware and `PlanLimitObserver`) | — |

---

## Response shape and error codes

Success (`ok()` / `okMessage()` in `src/interfaces/http/respond.ts`):

```json
{ "success": true, "data": { } }
{ "success": true, "message": "تم انشاء اذن المخزن بنجاح", "data": { } }
```

Reads return `{ success, data }`; writes return `{ success, message, data }` (`data` is `null` for update / delete / reject / remove-product). Paginated lists put the page inside `data`:

```json
{ "success": true, "data": { "items": [ ], "total": 55, "page": 1, "perPage": 10, "lastPage": 6 } }
```

Errors (`errorHandler.ts`, `AppError`) always carry a machine `code` and an Arabic `message`; validation adds `details { field: [messages] }` (permit lines use dots: `items.0.quantity`, `items.1.productId`). The top-level `message` is the **first** error only:

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "أضف صنفاً واحداً على الأقل إلى الإذن.", "details": { "items": ["أضف صنفاً واحداً على الأقل إلى الإذن."] } } }
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `PERMIT_NOT_APPROVED` | Cancel approval of a permit that is not approved («هذا الإذن غير موافق عليه مسبقاً») |
| 401 | `MISSING_TOKEN` / `INVALID_TOKEN` / `TOKEN_EXPIRED` / `TOKEN_REVOKED` / `USER_NOT_FOUND` | No/invalid/expired token, or the password changed since the token was issued |
| 402 | `NO_SUBSCRIPTION` / `SUBSCRIPTION_EXPIRED` / `SUBSCRIPTION_SYNC_LOCKED` / `SUBSCRIPTION_INACTIVE` | Subscription gate (`EnsureSubscription` messages) |
| 402 | `PLAN_FEATURE_UNAVAILABLE` | The plan does not include the section's feature — `details.features` |
| 402 | `PLAN_LIMIT_REACHED` | A plan limit (`warehouse_permits`, `price_lists`, `internal_notifications`) has no room left — `details { feature, remaining }`; the operation is rolled back |
| 403 | `MODULE_DISABLED` | «إدارة المخزون» (`inventory_management`) turned off in «شاشة التطبيقات» |
| 403 | `FORBIDDEN` | Missing route permission, or missing the create permission of the permit type |
| 403 | `WAREHOUSE_FORBIDDEN` | Warehouse outside the user's scope («لا تملك صلاحية الوصول إلى هذا المستودع.») |
| 403 | `RECORD_FORBIDDEN` | Permit created by someone outside the user's scope («لا تملك صلاحية الوصول إلى هذا السجل.») |
| 403 | `PRODUCT_FORBIDDEN` | Adding to a price list a product the user cannot see |
| 404 | `NOT_FOUND` | Non-numeric id in the path |
| 404 | `WAREHOUSE_NOT_FOUND` / `PERMIT_NOT_FOUND` / `PRODUCT_NOT_FOUND` / `PRICE_LIST_NOT_FOUND` / `PRICE_LIST_ITEM_NOT_FOUND` | Record not found |
| 404 | `NO_WAREHOUSES` | Statement with no warehouse in the system / in the user's scope |
| 404 | `ROUTE_NOT_FOUND` | Unknown path **or wrong HTTP method** (Express has no 405) |
| 413 | `PAYLOAD_TOO_LARGE` | JSON body over 4 MB |
| 422 | `VALIDATION_ERROR` | Validation (`details`); multipart limit errors also land here. Warehouse scope on create/update is reported here on the field |
| 422 | `PRODUCTS_INACTIVE` | A line uses a product whose status is not `active` |
| 422 | `STOCKLESS_PRODUCT` | A line uses a service or digital product |
| 422 | `INSUFFICIENT_STOCK` | Disbursement / transfer quantity above the warehouse balance at save time |
| 422 | `ACCOUNTING_PERIOD_CLOSED` | The date falls in a closed/locked period (see [Settings](#settings-that-change-behaviour)) |
| 422 | `PERMIT_NOT_PENDING` / `PERMIT_APPROVED` | Update / reject of a non-pending permit; delete / reject of an approved permit |
| 422 | `PERMIT_APPROVAL_FAILED` | Approval refused (web messages: already approved, product missing, quantity not available, account not linked, journal entry failed …) |
| 422 | `PLAN_LIMIT_REACHED` | Journal-entry quota reached **during approval** — message prefixed «فشل إنشاء القيد المحاسبي: », `details { feature: "journal_entries", remaining }` |
| 422 | `PERMIT_STORE_FAILED` / `PERMIT_REJECT_FAILED` | Unexpected failure while saving / rejecting (web messages «حدث خطا ما برجاء المحاوله لاحقا: …» / «حدث خطأ أثناء رفض الإذن: …») — logged to `error_logs` |
| 422 | `UNSUPPORTED_FILE` | Attachment content could not be read as JPEG/PNG/PDF at upload time (a wrong type or a file over 5 MB is normally caught earlier as `VALIDATION_ERROR` on `attachments`) |
| 500 | `CANCEL_APPROVAL_FAILED` | Cancel approval failed (e.g. reversing entries could not be written) — nothing was changed; logged to `error_logs` |
| 502 | `MEDIA_UPLOAD_FAILED` | The ERP did not accept the attachment — nothing was saved |
| 503 | `UPLOADS_NOT_CONFIGURED` | `ERP_MEDIA_TOKEN` not set, so attachments cannot be uploaded to the ERP |
| 429 | `RATE_LIMITED` | 240 requests/min per IP on `/api/v1` |

---

## Gates

Applied by `StockContextFactory.load()` → `ErpGate.enter()` in the same order as the web / integration middleware, before any logic:

1. `authenticate` — valid JWT and unchanged password (`401`).
2. Subscription (`EnsureSubscription`) — when `ENFORCE_SUBSCRIPTION=true` (default) the cached subscription snapshot must exist, not be expired and be active ⇒ otherwise `402` `NO_SUBSCRIPTION` / `SUBSCRIPTION_EXPIRED` / `SUBSCRIPTION_SYNC_LOCKED` / `SUBSCRIPTION_INACTIVE`.
3. Application key `inventory_management` «إدارة المخزون» (`module:inventory_management`) — must be `active` in `application_settings` ⇒ otherwise `403 MODULE_DISABLED`.
4. Plan feature (`plan:`) ⇒ `402 PLAN_FEATURE_UNAVAILABLE` with the feature's label from the subscription screen:

   | Endpoints | Feature |
   |---|---|
   | `stock/warehouses*`, `stock/statement*` | `stock_storehouses` |
   | `stock/permits*` | `stock_warehouse_permits` |
   | `stock/price-lists*` | `stock_price_lists` |

5. Route permission (`permission.role:`) — every listed condition, each satisfied by any one of its alternatives ⇒ otherwise `403 FORBIDDEN`.
6. Plan limits (`plan.limit:` on the route, then again inside the save transaction like `PlanLimitObserver`, so two parallel requests cannot overshoot):

   | Limit | Kind | Checked at |
   |---|---|---|
   | `warehouse_permits` | quota (created in the plan window — daily / monthly / whole plan) | `POST stock/permits` — **before validation**, and again inside the transaction |
   | `journal_entries` | quota | Whenever an approval writes a journal entry (approve, opening-balance save) and for each reversing entry on cancel |
   | `price_lists` | cap (all existing rows) | `POST stock/price-lists` — before validation, and again inside the transaction |
   | `internal_notifications` | quota | Approve / reject (the notification to the permit creator) |

   Used = the larger of the Fawtra snapshot and the live row count in the window. No room ⇒ `402 PLAN_LIMIT_REACHED` with the web message «بلغت حدّ «…» في باقة فوترة: N من M. …» and `details { feature, remaining }`. Where the limit is hit inside an approval it surfaces as described in [Approval](#4-approval).
7. Inside the use case: data scope, permit type permission, permit status, settings.

---

## Data scope — who sees what

Port of `ScopesToEmployeeHierarchy` + `StorehouseAccess` (`StockContext`). Each set is computed once per request; "no limit" and "nothing" are distinct.

**Warehouses** (`accessibleWarehouseIds()`):

1. *Header branch* — the warehouses whose `store_houses.branch_id` lies in the subtree of the branch selected in the web header (`DataScope` header branch). No header branch ⇒ no branch limit.
2. *People* — for a user with `data_scope_all`, or a user who is not an employee: the header-branch warehouses only. For an employee: the data-scope ladder (`DataScope::documentEmployees()`) plus the user himself and everyone under him in the management hierarchy; their **default warehouses** (`default_warehouses`) intersected with the header-branch warehouses. If the ladder returns "no limit", only the header-branch limit applies.
3. *Warehouse view audience* — for employees without `data_scope_all`, and only when at least one warehouse restricts its view audience: the warehouse's «عرض» audience must allow the user (all / the employee or a member of his team / his job role `users.role_id` / his branch or his employee branch). The result is intersected with 2.

So a store keeper or plain employee without `data_scope_all` sees only the warehouses assigned to him (and to his team) that his header branch and the view audience allow.

**Permits** (`GET stock/permits`) — both conditions:

- created by an accessible user (`DataScope::documentUserIds()` + the user + his team's users), and
- any of `store_houses_id`, `from_store_houses_id`, `to_store_houses_id` is an accessible warehouse.

**Single permit** (show, update, delete, reject, approve, cancel approval) — creator scope only ⇒ `403 RECORD_FORBIDDEN`.

**Create / update** — every warehouse sent (`warehouseId`, `fromWarehouseId`, `toWarehouseId`) must be accessible ⇒ `422 VALIDATION_ERROR` on that field («لا تملك صلاحية الوصول إلى هذا المستودع.»), as the web's `assertWarehouseAccess()`.

**Warehouse screens** — `GET stock/warehouses` lists accessible warehouses only; `show` / `movements` / `product-stock` answer `403 WAREHOUSE_FORBIDDEN` outside the scope. In the statement a warehouse outside the scope (or none sent) silently falls back to the first accessible warehouse by name, as on the web.

Per-warehouse flags in every warehouse payload — `canView`, `canCreateInvoices`, `canEditStock` — are the warehouse's own audience columns (`view_permissions`, `crate_invoices_permissions`, `edit_stock_permissions`) evaluated for the user (always `true` for non-employees and `data_scope_all`). `canViewDetails` / `canViewMovements` / `canViewStatement` are the route permissions.

**Price lists** — lists themselves are not scoped (as on the web). Products offered/accepted for a list follow `scopeToProductVisibility()`: unrestricted users see every product; otherwise products having a `product_details` row in an accessible warehouse; a user with no accessible warehouse sees the products created by the users in his scope.

**Invoice figures on warehouse screens** — `sold` / `salesReturns` (show) and `soldQuantity` / `salesReturnQuantity` (movements) count the invoice lines from the warehouse; for an employee only the invoices he created are counted, as on the web.

---

## Settings that change behaviour

| Setting (web screen) | Effect here |
|---|---|
| «شاشة التطبيقات» — «إدارة المخزون» | All stock endpoints (`MODULE_DISABLED`) |
| Accounting period settings (`accounting_period_settings`): enforce lock, lock-before date, block future dates, block dates with no period, override permission (default `settings.accounting_periods.override`) | Period guard on create (permit date), approve (permit date) and cancel approval (today) — see below |
| Accounting periods / fiscal years | `accounting_period_id` stamped on permits and journal entries; list filter `periodId`; statement default range |
| «الترقيم المتسلسل» (`serial_settings`) — `warehouse-add`, `warehouse-dispose`, `transfer-request` | Permit numbers |
| «إعدادات الحسابات المحاسبية» (`accounting_settings`) — `warehouse_accounts_parent`, `inventory`, `opening_balance`, `other_creditor_parties`, `other_debtor_parties`, `purchases`, `cost_of_sales`, `inventory_adjustment` | Accounts of the approval journal entry; unlinked keys fall back to the system account ids like `SystemAccountIds` (`opening_balance` 38, `cost_of_sales` 50, `purchases` 25, `inventory` 16, `other_debtor_parties` 20, `other_creditor_parties` 33) |
| Default currency | List filter default; journal entry currency when the permit has none |
| Notification type settings (`notification_settings`) | A disabled type (`success` on approve, `error` on reject) is not created (silently) |

**Accounting period guard** (`AccountingPeriodGuard`, port of `RespectsAccountingPeriods`): with `settings.accounting_periods.override` (or whichever permission the settings name) the check is skipped. Otherwise, when locking is enforced, the date is refused with the web lang-file message (`settings.accounting_periods.block.*`):

| Reason | Message |
|---|---|
| Before the lock date | «التاريخ :date سابق لتاريخ القفل :lock_date.» |
| Future date (when blocked) | «التاريخ :date مستقبلي، والقيد بتاريخ مستقبلي ممنوع.» |
| No period covers the date (when blocked) | «التاريخ :date لا تغطّيه أي فترة محاسبية معرَّفة.» |
| Period locked | «الفترة «:period» مقفلة نهائياً — لا يُقبل قيد بتاريخ :date.» |
| Period closed | «الفترة «:period» مقفلة — لا يُقبل قيد بتاريخ :date.» |
| Fiscal year not open | «التاريخ :date يقع في السنة المالية «:year» وهي مقفلة.» |

Refusal ⇒ `422 ACCOUNTING_PERIOD_CLOSED`. A check that itself fails (settings tables missing) allows the operation, as the web does. Update does not re-run the guard (the approval does).

---

## Time, numbers, logs and notifications

- **Time** — written in the ERP timezone (`APP_TIMEZONE`, default `Asia/Riyadh`) as naive local times (`Y-m-d H:i:s`), like Laravel. "Today" (cancel-approval date, period guard, statement default range) is computed in that zone. `permissionDate` is stored exactly as sent (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM[:SS]`).
- **Permit numbers** — issued from «الترقيم المتسلسل» inside the save transaction with the settings row locked (`FOR UPDATE`): additions and opening balances use section `warehouse-add`, disbursements `warehouse-dispose`, transfers `transfer-request`. Any number sent by the app is ignored; a failed save does not burn a number. `GET stock/permits/create-data` returns `serialNumber` as a preview only (`""` if it cannot be computed). Update keeps the permit's number (a permit without one gets one).
- **Journal entry numbers** — `AW-<year>-<NNNNN>` (next after the highest `AW-<year>-…`), `reference_type = AW`, `batch_reference = WAREHOUSE_<permitId>`, `reference_id = <permitId>`. Reversing entries: `REVERSE_<original reference>_<unix time>`, `reference_type = STK`.
- **Permit log** (the «سجل» on the permit screen, `logs.type = warehouse_permit_log`, plus a row in `event_logs`) — on create, one line per item with the web's text («أُنشئ إذن إضافة (بانتظار الاعتماد) كمية **N** من المنتج **…** إلى **…**», transfer and opening variants; disbursements write none, as on the web); on reject «تم رفض إذن المخزن رقم **…**». User, IP, user agent and route (`api.stock.<route>`) are recorded. Failures go to `error_logs` (+ `event_logs`).
- **Price list log** — written straight into `logs` like the web's `Logs::create()`: type `price_list` on create/update («تم  اضافة قائمة اسعار :  **…**», «تم تعديل قائمة الأسعار من **…** إلى **…**»), type `product_log` on delete («تم  حذف قائمة اسعار :  **…**»).
- **Notifications** — approve and reject notify the **permit creator** (`created_by`): «تمت الموافقة على الإذن المخزني رقم …» (`success`) / «تم رفض الإذن المخزني رقم …» (`error`). They are written inside the transaction through the notification gate (type setting + `internal_notifications` limit).
- **Message numbers** — quantities in messages are printed without trailing zeros (`المتاح 5 والمطلوب 7.5`), like PHP prints them.

---

## The permit cycle

```
                 create ──► pending ──► approve ──► approved ──► cancel-approval ──► pending
                   │           │  ▲                                    (source 25 ──► rejected)
 opening balance ──┘           │  └── update (pending only)
 (approved in the same save)   ├──► reject ──► rejected
                               └──► delete (pending or rejected)
```

| Type | `permissionType` | Create permission | Number section | `permission_source_id` | Warehouse fields |
|---|---|---|---|---|---|
| Addition «إذن إضافة» | 1 | `stock.permits.create_addition` | `warehouse-add` | 1 | `warehouseId` |
| Disbursement «إذن صرف» | 2 | `stock.permits.create_disbursement` | `warehouse-dispose` | 2 | `warehouseId` |
| Transfer «إذن تحويل» | 3 | `stock.permits.create_transfer` | `transfer-request` | 13 | `fromWarehouseId` + `toWarehouseId` (different) |
| Opening balance «رصيد افتتاحي» | 4 | `stock.permits.create_opening` | `warehouse-add` | 26 | `warehouseId` |

- Status keys in the API are `pending` / `approved` / `rejected`; the table stores `pending` / `apporod` / `rejec` (historic spellings — the API translates both ways, also in the list filter).
- **Quantities move only on approval.** Save records the lines with `stock_before` / `stock_after` for display; disbursement and transfer lines are refused at save time when the warehouse (the source warehouse for transfers) holds less than the line quantity (`422 INSUFFICIENT_STOCK`).
- **Opening balance** is approved inside the same save transaction: it is saved approved or not at all. An approval failure is returned with the message prefixed «لم يُحفظ الرصيد الافتتاحي: » (`422`, or `402` for a notification-limit refusal).
- Header warehouse (`store_houses_id`): the source warehouse for transfers, otherwise `warehouseId`. `from_store_houses_id` / `to_store_houses_id` are written only for transfers.

**Approval journal routing** (`createApprovalJournalEntry()`; amount = Σ quantity × unit price; no entry when it is 0):

| Permit source | Debit | Credit | Description |
|---|---|---|---|
| 26 opening balance | warehouse account | `opening_balance` | «قيد رصيد افتتاحي للمخزون رقم …» |
| 25 inventory adjustment, type 1 (surplus) | warehouse account | `inventory_adjustment` (fallback `cost_of_sales`) | «قيد زيادة جرد رقم …» |
| 25 inventory adjustment, other types (shortage) | `inventory_adjustment` | warehouse account | «قيد عجز جرد رقم …» |
| 1 manual addition | warehouse account | `other_creditor_parties` | «قيد إضافة مخزنية يدوية رقم …» |
| 10, 6, 8, 11 (purchase-type additions) | warehouse account | `purchases` | «قيد إضافة بضاعة - <source> رقم …» |
| 2 manual disbursement | `other_debtor_parties` | warehouse account | «قيد صرف مخزني يدوي رقم …» |
| 5, 7, 14, 17 (sales-type disbursements) | `cost_of_sales` | warehouse account | «قيد صرف بضاعة - <source> رقم …» |
| 13 transfer | to-warehouse account | from-warehouse account | «قيد تحويل مخزني من … إلى … — إذن رقم …» |
| anything else | — refused: «نوع مصدر الإذن غير مدعوم للقيود المحاسبية: …» | | |

- The **warehouse account** is the `accounts` row with `storehouse_id` = the warehouse. If missing it is created («حساب المستودع - <name>», asset, debit nature, next free code `<parent code>NN`) under `warehouse_accounts_parent` (fallback: the `inventory` account); an existing one without parent is attached to that parent.
- A required account that is not linked stops the approval: «فشل إنشاء القيد المحاسبي: حساب «…» غير مربوط في «إعدادات الحسابات المحاسبية». اربطه من الشاشة ثم أعد المحاولة.»
- The entry is dated with the permit date, in the permit currency (else the default), with branch = the user's employee branch (else the user branch), employee = the user's employee, and the accounting period of that date.
- Balances are recomputed like the web: each detail updates its account and ancestors (`updateParentBalances`), then the purchases or cost-of-sales account (for those sources) and the warehouse account are recomputed hierarchically (`updateBalancesHierarchically`).

---

## Uploads

The permit attachment never stays on this server: it is uploaded as is (no compression) to the ERP (`POST {ERP_MEDIA_URL}/api/mobile-media`, Laravel `App\Http\Controllers\Api\MobileMediaController`, header `X-Media-Token` = shared secret `ERP_MEDIA_TOKEN` / `MOBILE_MEDIA_TOKEN`).

| Field | Endpoint | Rule | Stored in (ERP `public/`) |
|---|---|---|---|
| `attachments` (single file) | `POST stock/permits`, `PUT/POST stock/permits/{id}` | JPEG / PNG / PDF, ≤ 5 MB (5120 KB), optional | `assets/uploads/warehouse/` |

- The type is detected from the content (PDF `%PDF-` header, JPEG/PNG magic bytes), never from the name or MIME header. The ERP accepts PDF in this folder only (`DOCUMENT_FOLDERS`), with a generated safe file name (`<unix>_<hex>.pdf|jpg|png`) and never overwrites a file.
- The stored value is the file name in `warehouse_permits.attachments` (as the web stores it); `GET stock/permits/{id}` returns it in `attachments` — the file is served at `{ERP_PUBLIC_URL}/assets/uploads/warehouse/<attachments>`.
- On update a new file replaces the reference; without a file the existing attachment is kept.
- If the save fails after the upload, the uploaded file is deleted again on the ERP (`POST /api/mobile-media/delete`).
- In multipart, send the lines either as `items` = a JSON string of the array, or in bracket notation (`items[0][productId]`, `items[0][quantity]` …).
- Multer technical caps: 25 MB per file, 40 files, 300 fields, 4 MB per text field; exceeding one ⇒ `422 VALIDATION_ERROR`.

---

## Endpoint index

| # | Method | Path | Permission |
|---|---|---|---|
| 1.1 | GET | `stock/warehouses` | `stock.warehouses.view` |
| 1.2 | GET | `stock/warehouses/{id}` | `stock.warehouses.view` **and** `stock.warehouses.show` |
| 1.3 | GET | `stock/warehouses/{id}/movements` | `stock.reports.summary_movement` |
| 2.1 | GET | `stock/statement/warehouses` | `stock.reports.employee_statement` |
| 2.2 | GET | `stock/statement` | `stock.reports.employee_statement` |
| 3.1 | GET | `stock/permits` | `stock.permits.view` |
| 3.2 | GET | `stock/permits/create-data?type=` | any create (route) + create of `type` |
| 3.3 | GET | `stock/permits/product-stock/{warehouseId}/{productId}` | `stock.permits.view` |
| 3.4 | GET | `stock/permits/{id}` | `stock.permits.show` |
| 3.5 | POST | `stock/permits` | any create (route) + create of `permissionType` |
| 3.6 | PUT / POST | `stock/permits/{id}` | `stock.permits.edit` + create of `permissionType` |
| 3.7 | DELETE | `stock/permits/{id}` | `stock.permits.delete` |
| 4.1 | POST | `stock/permits/{id}/approve` | `stock.permits.approve` |
| 4.2 | POST | `stock/permits/{id}/reject` | `stock.permits.reject` |
| 4.3 | POST | `stock/permits/{id}/cancel-approval` | `stock.permits.cancel_approval` |
| 5.1 | GET | `stock/price-lists` | `stock.price_lists.view` |
| 5.2 | GET | `stock/price-lists/{id}` | `stock.price_lists.show` |
| 5.3 | POST | `stock/price-lists` | `stock.price_lists.create` |
| 5.4 | PUT | `stock/price-lists/{id}` | `stock.price_lists.edit` |
| 5.5 | DELETE | `stock/price-lists/{id}` | `stock.price_lists.delete` |
| 5.6 | POST | `stock/price-lists/{id}/products` | `stock.price_lists.manage_products` |
| 5.7 | DELETE | `stock/price-lists/products/{itemId}` | `stock.price_lists.manage_products` |

*any create* = `stock.permits.create_addition | stock.permits.create_disbursement | stock.permits.create_transfer | stock.permits.create_opening`.

The route order in `routes/stock.ts` matters: `stock/permits/create-data` and `stock/permits/product-stock/…` are declared before `stock/permits/:id`.

---

## 1) Warehouses

Read only — warehouses are created and edited on the web.

### 1.1 `GET stock/warehouses`

Query: `keywords` (name or shipping address, ≤ 100), `status` (as stored, e.g. `active`), `perPage` (10 / 25 / 50 / 100 — anything else means 10), `page`. Newest first (`id desc`).

```json
{ "success": true, "data": { "items": [
  { "id": 3, "name": "المستودع الرئيسي", "status": "active", "shippingAddress": "الرياض — حي السلي", "branch": "الفرع الرئيسي",
    "isDefault": true, "productsCount": 42, "totalQuantity": 1830, "stockValue": 51240.5, "responsibleEmployees": ["أحمد السالم"],
    "canView": true, "canCreateInvoices": true, "canEditStock": true,
    "canViewDetails": true, "canViewMovements": true, "canViewStatement": true } ],
  "total": 1, "page": 1, "perPage": 10, "lastPage": 1 } }
```

`isDefault` = one of the user's own default warehouses; `productsCount` / `totalQuantity` from `product_details`; `stockValue` = Σ quantity × purchase price; `responsibleEmployees` = the employees having the warehouse as default.

### 1.2 `GET stock/warehouses/{id}`

Port of `buildAccountingOverview()`. `warehouse` is the list payload; `items[]` one row per product that has stock or an approved permit line in the warehouse (sorted by name):

```json
{ "id": 120, "name": "مياه 330 مل", "barcode": "6281000000017", "currentQuantity": 150,
  "incomingManual": 100, "incomingOpening": 80, "incomingTransfer": 20, "incomingTotal": 200,
  "outgoingManual": 30, "outgoingTransfer": 20, "sold": 12, "salesReturns": 2, "withdrawnTotal": 62,
  "unitCost": 1.25, "stockValue": 187.5 }
```

- Incoming/outgoing columns come from **approved** permits (type 1 manual addition, 2 manual disbursement, 3 transfer in/out, 4 opening). `sold` = normal + POS invoice lines, `salesReturns` = returned invoice lines (see [Data scope](#data-scope--who-sees-what) for employees).
- `unitCost` = weighted average cost in this warehouse, else the general average, else the purchase price (permit sources 13, 14, 15, 7, 8, 9, 2, 18 excluded from the average).
- `totals{}` sums the quantity columns; `totalStockValue` = Σ `stockValue`; `accountBalance` = balance of the warehouse's ledger account (`null` if none); `valueDifference` = `totalStockValue − accountBalance` (2 decimals, `null` without account).
- `logs[]` = the warehouse's activity log (`storehouse_log`), newest first: `{ date, description, user }`.

### 1.3 `GET stock/warehouses/{id}/movements`

Port of `searchSummaryInventoryOperations()`. Query: `keywords` (product name, case-insensitive), `category`, `operationType` = `incoming` (incoming total > 0) / `outgoing` (outgoing total > 0) / `transfer` (any transfer in or out). One row per product with approved permit lines: `incomingManual, incomingOpening, incomingTransfer, outgoingManual, outgoingTransfer, incomingTotal, outgoingTotal, movementTotal (= in − out), soldQuantity, salesReturnQuantity`. Also returns `storehouse { id, name, status, shippingAddress, branchId }` and `categories[]` for the filter. The scope check runs before the existence check, so an unknown id outside a restricted scope answers `403 WAREHOUSE_FORBIDDEN`.

---

## 2) Warehouse statement

### 2.1 `GET stock/statement/warehouses`
Accessible warehouses `[{ id, name }]` ordered by name — the picker of the statement.

### 2.2 `GET stock/statement`

Port of `WarehouseStatementController`. Query (all optional): `warehouse`, `startDate`, `endDate` (`YYYY-MM-DD`, a real calendar date), `periodId` (`all`, `none`, `year:<fiscalYearId>`, `<periodId>`), `product`, `category`, `brand`, `permissionSource`.

- **Warehouse** — the one sent if accessible, otherwise the first accessible warehouse by name; no warehouse at all ⇒ `404 NO_WAREHOUSES` («لا توجد مستودعات مسجَّلة في النظام بعد.» / «لا توجد مستودعات ضمن نطاقك حالياً.»).
- **Range** — the dates sent (one date alone is used for both ends; reversed dates are swapped); else the chosen `periodId` (default: the current fiscal year); else the accounting period of today; else the current month/quarter/half/year from the default period type.
- **Lines** — approved permit lines (`approved`, `apporod`, `delivered`, `done`) that touch the warehouse: header warehouse without from/to, outgoing lines of a transfer from it, incoming lines of a transfer to it. Order: opening balances first, then date, creation time, permit id, and **line id** (stable order inside one permit).
- **Balances** — `openingBalance` from the lines before the range; each movement carries `balanceBefore`, `balanceAfter` (= `balance`), and the split `goodBalance` / `damagedBalance` (damaged sources: 28, 24, 4, 16, and transfers into a major warehouse; outgoing damaged movements consume the damaged balance first). `currentStock` = the live quantity in `product_details` (for `product` if sent).

```json
{ "id": 6120, "date": "2026-09-14 10:30:00", "type": "اذن صرف مخزني", "reference": "#WD-00045",
  "productName": "مياه 330 مل", "productCode": "P-0120", "quantity": 5, "incoming": 0, "outgoing": 5,
  "balanceBefore": 155, "balanceAfter": 150, "balance": 150, "goodBalance": 150, "damagedBalance": 0, "isDamaged": false,
  "exchangeReason": null, "userName": "أحمد السالم", "notes": null, "clientTradeName": null, "clientCode": null, "transferInfo": null }
```

`clientTradeName` / `clientCode` come from the permit's client, else the referenced invoice / credit note, else the last sales invoice of the product up to that date (as the web). `transferInfo { from, to }` is set on transfers. `exchangeReason` is the exchange item's reason (`ProductExchangeItem::reason_text`: the reason name, else the legacy enum text, else «غير محدد») on exchange permits (sources 27/28) linked to their exchange; `null` otherwise. `products[]` = stocked products present in the warehouse (`{ id, name, serialNumber }`) for the product filter.

---

## 3) Permits

### 3.1 `GET stock/permits`

Filters (all optional; empty values are ignored): `keywords` (number or details), `status` (`pending` / `approved` / `rejected`), `permissionType` (1–4), `permissionSource`, `warehouse` (header warehouse), `client` / `supplier` (the permit's sub-account), `currency` (absent ⇒ the system default currency; present but empty ⇒ all currencies — web `filterCurrency()`), `createdBy` (user id), `product` (permits containing it), `periodId` (`all` / `none` = no period / `year:<id>` / `<periodId>`; default = the current fiscal year's periods, no filter when no fiscal year exists), `fromDate`, `toDate` (on the permit date), `branch` (creator's `users.branch_id`), `perPage` (10 / 25 / 50 / 100, default 10), `page`. Newest first.

```json
{ "id": 812, "number": "WA-00123", "type": 1, "typeLabel": "إذن إضافة", "status": "pending", "date": "2026-09-27",
  "warehouse": "المستودع الرئيسي", "fromWarehouse": null, "toWarehouse": null, "grandTotal": 250, "currency": "SAR",
  "details": "توريد يدوي", "createdBy": "أحمد السالم",
  "canEdit": true, "canDelete": true, "canApprove": true, "canReject": true, "canCancelApproval": false }
```

The `can*` flags combine permission, creator scope and status: edit (pending, `stock.permits.edit` + the type's create permission), delete (not approved), approve / reject (pending), cancel approval (approved).

### 3.2 `GET stock/permits/create-data?type=1|2|3|4`

What the create screen of the type needs (web `create`, `manual_disbursement`, `manual_conversion`, `opening_balance`). The route requires any create permission; the type's own permission is then required (`403 FORBIDDEN`); a missing/unknown type ⇒ `422`.

```json
{ "success": true, "data": { "type": 1, "serialNumber": "WA-00124",
  "warehouses": [ { "id": 3, "name": "المستودع الرئيسي" } ],
  "products": [ { "id": 120, "name": "مياه 330 مل", "barcode": "6281000000017", "purchasePrice": 1.2, "salePrice": 2 } ] } }
```

`warehouses` — accessible warehouses; for additions and opening balances only `active` ones. `products` — stocked products (types `products` / `compiled`).

### 3.3 `GET stock/permits/product-stock/{warehouseId}/{productId}`

The available quantity (sum of the product's `product_details` rows in the warehouse) — use it to show the balance while filling a disbursement / transfer line.

```json
{ "success": true, "data": { "stock": 1250.5, "formatted": "1,250.50" } }
```

### 3.4 `GET stock/permits/{id}`

The list payload plus `items[] { id, productId, productName, quantity, unitPrice, total }` (in entry order), `attachments` (file name or `null`), `rejectionReason`, and `logs[] { date, description }` (the permit log, newest first).

### 3.5 `POST stock/permits`

JSON (or multipart when attaching a file):

| Field | Rule |
|---|---|
| `permissionType` * | 1 addition · 2 disbursement · 3 transfer · 4 opening balance |
| `permissionDate` * | `YYYY-MM-DD` or `YYYY-MM-DD HH:MM[:SS]`, a real date |
| `warehouseId` | required for types 1, 2, 4 — existing and accessible |
| `fromWarehouseId`, `toWarehouseId` | required for type 3, different, existing and accessible |
| `grandTotal` * | number ≥ 0.01 (the stored total is Σ line `total`, rounded to 2 decimals — ≤ 99,999,999.99) |
| `details` | text ≤ 65,535 bytes |
| `items` * | at least one line: `{ productId*, quantity* (0.01 … 99,999,999,999,999), unitPrice* (0 … 99,999,999.99), total* (0 … 99,999,999.99) }`; in multipart a JSON string of the array or `items[i][field]` |
| `attachments` | file, JPEG / PNG / PDF ≤ 5 MB |

```json
POST stock/permits
{ "permissionType": 2, "permissionDate": "2026-09-27", "warehouseId": 3, "grandTotal": 12.5,
  "details": "صرف عيّنات", "items": [ { "productId": 120, "quantity": 5, "unitPrice": 2.5, "total": 12.5 } ] }
→ 201 { "success": true, "message": "تم انشاء اذن المخزن بنجاح", "data": { "id": 813, "number": "WD-00046", "status": "pending" } }
```

Order of checks: gates → `warehouse_permits` limit (`402`) → validation (`422`) → type permission (`403`) → warehouse scope (`422` on the field) → products active and stocked (`422 PRODUCTS_INACTIVE` / `STOCKLESS_PRODUCT`) → period guard on the permit date (`422 ACCOUNTING_PERIOD_CLOSED`) → attachment upload → transaction: limit again, number, header, lines (`422 INSUFFICIENT_STOCK` for types 2/3), log, and for type 4 the approval. Opening balance answers «تم إنشاء الرصيد الافتتاحي واعتماده وإضافة الكميات إلى المستودع» with `status: "approved"`.

### 3.6 `PUT stock/permits/{id}` (also `POST`)

Same body as 3.5. Only a **pending** permit (`422 PERMIT_NOT_PENDING` — «لا يمكن تعديل إذن معتمَد — ألغِ الاعتماد أولاً.» / «لا يمكن تعديل إذن مرفوض.»); the status is re-checked under a row lock inside the transaction. Header and lines are replaced (the number is kept); the type permission and warehouse scope are checked as on create. As on the web, the editing user is written as the permit's `created_by`. No stock check at update time (the approval checks). `200` «تم تحديث إذن المخزن — يبقى بانتظار الاعتماد», `data: null`.

### 3.7 `DELETE stock/permits/{id}`

Pending or rejected permits only; an approved permit ⇒ `422 PERMIT_APPROVED` («لا يُحذف إذنٌ معتمد — ألغِ اعتماده أولاً.»). Lines and header are deleted under a row lock. `200` «تم حذف الإذن المخزني بنجاح».

---

## 4) Approval

### 4.1 `POST stock/permits/{id}/approve`

In one transaction, with the permit row locked (a double or triple tap moves stock once — later taps get «هذا الإذن تمت الموافقة عليه مسبقاً»):

1. Creator scope (`403 RECORD_FORBIDDEN`). Purchase-receiving permits are refused («يُعتمد إذن استلام المشتريات من شاشة «استلام المشتريات» لا من هنا.»).
2. Period guard on the permit date (`422 ACCOUNTING_PERIOD_CLOSED`).
3. Products active; permit still pending.
4. Target warehouse: transfers → the to-warehouse; others → the permit warehouse, else the major warehouse («لم يتم العثور على المستودع المطلوب»).
5. Quantities (on the product's first `product_details` row, locked):
   - addition / opening: `+qty` (row created if missing; a service/digital product is refused);
   - disbursement: the row must exist («المنتج غير موجود في المستودع») and hold the quantity («الكمية المطلوبة أكبر من الكمية المتاحة»), `−qty`;
   - transfer: the same on the from-warehouse («… في المستودع المصدر»), then `+qty` on the to-warehouse.
6. Status `apporod`; a linked, not-yet-received purchase invoice gets its lines added and is marked received.
7. Journal entry (see [routing](#the-permit-cycle)); balances recomputed; an inventory-adjustment sheet is closed (`adjusted`) when none of its permits is still pending.
8. Notification to the creator.

```json
→ 200 { "success": true,
  "message": "تمت الموافقة على الإذن المخزني رقم WD-00046 بنجاح وتم تنفيذه في المستودع: المستودع الرئيسي وتم إنشاء القيد المحاسبي",
  "data": { "id": 813, "status": "approved" } }
```

Refusals: `422 PERMIT_APPROVAL_FAILED` with the web message (journal failures are prefixed «فشل إنشاء القيد المحاسبي: »); journal-entry quota ⇒ `422 PLAN_LIMIT_REACHED` «فشل إنشاء القيد المحاسبي: بلغت حدّ …» (`details { feature: "journal_entries", remaining }`); notification quota ⇒ `402 PLAN_LIMIT_REACHED` (`internal_notifications`). Any refusal rolls everything back.

### 4.2 `POST stock/permits/{id}/reject`

Body (or query) `reason` — the old name `rejectionReason` is accepted — optional, ≤ 5000 chars. Only a pending permit: approved ⇒ `422 PERMIT_APPROVED` («لا يمكن رفض إذن تمت الموافقة عليه بالفعل»), rejected ⇒ `422 PERMIT_NOT_PENDING` («هذا الإذن تم رفضه مسبقاً»). Writes `rejec`, `rejection_reason`, `rejected_by`, `rejected_at`, the log line and the notification to the creator, under a row lock. `200` «تم رفض الإذن المخزني رقم … بنجاح». A notification-limit refusal comes back as `422 PERMIT_REJECT_FAILED` («حدث خطأ أثناء رفض الإذن: …»).

### 4.3 `POST stock/permits/{id}/cancel-approval`

1. Permit found and creator in scope (`404` / `403`).
2. Period guard with **today's** date (the reversing entries are dated today) ⇒ `422 ACCOUNTING_PERIOD_CLOSED`.
3. Transaction, permit row locked; not approved ⇒ `400 PERMIT_NOT_APPROVED`.
4. Quantities reversed on the product's first stock row (addition/opening `−qty`, disbursement `+qty`, transfer `−qty` on the to-warehouse and `+qty` on the from-warehouse) — without a balance check, as on the web.
5. Every journal entry of the permit (`reference_id` = permit or `batch_reference = WAREHOUSE_<id>`, types `STK` / `AW` / `OPB`, not yet reversed, not itself a reversal) gets a reversing entry `REVERSE_<ref>_<unix>` (`STK`, dated today, «قيد عكسي لـ …», details with debit/credit swapped «عكس - …»), balances recomputed, and the original is marked `is_reversed = 1`. Each reversing entry counts against the `journal_entries` quota.
6. Status back to `pending` — or, for inventory-adjustment permits (source 25), to `rejected`, and the adjustment sheet returns from `adjusted` to `completed`.

```json
→ 200 { "success": true, "message": "تم إلغاء الموافقة بنجاح وإرجاع الكميات وعكس القيود", "data": { "id": 813, "status": "pending" } }
```

A failure while writing the reversing entries (including the journal quota) rolls everything back and answers `500 CANCEL_APPROVAL_FAILED` («حدث خطأ أثناء إلغاء الموافقة: فشل في إنشاء القيود العكسية: …»).

---

## 5) Price lists

`status`: `0` = active «نشط», `1` = stopped «موقوف».

### 5.1 `GET stock/price-lists`
Filters: `keywords` (name), `product` (lists containing it), `category`, `brand` (lists containing a product of it), `status` (0 / 1), `page`. 10 per page, newest first. Items: `{ id, name, status, createdAt, canEdit, canDelete, canManageProducts }`.

### 5.2 `GET stock/price-lists/{id}`
The list payload plus `items[] { itemId, productId, name, salePrice }` — `itemId` is the link row (`price_list_items.id`) that 5.7 expects — and `availableProducts[] { id, name, salePrice }` (products the user may add, per [product visibility](#data-scope--who-sees-what); empty without `stock.price_lists.manage_products`).

### 5.3 `POST stock/price-lists`
`{ "name": "أسعار الجملة", "status": 0 }` — `name` required ≤ 255; `status` 0 / 1, default 0. `price_lists` cap checked before validation and inside the transaction. `201` «تم اضافه قائمه الاسعار بنجاج !!» with the list payload.

### 5.4 `PUT stock/price-lists/{id}`
Same body; a missing `status` keeps the current one. Validation runs before the existence check. `200` «تم تعديل قائمة الأسعار بنجاح».

### 5.5 `DELETE stock/price-lists/{id}`
`200` «تم حذف قائمة الأسعار بنجاح».

### 5.6 `POST stock/price-lists/{id}/products`
`{ "productId": 120, "salePrice": 2.25 }` — both required; `salePrice` 0 … 99,999,999.99; the product must exist (`422`) and be visible to the user (`403 PRODUCT_FORBIDDEN`). `201` «تم اضافه المنتج الي قائمه الاسعار بنجاج !!», `data { itemId, productId, salePrice }`. There is no duplicate check — adding the same product again inserts another link row.

> As in the web, adding a product to a list writes the price on `products.sale_price` — the product's global sale price, used everywhere the product is sold — and `price_list_items.sale_price` is not used by the web. A list therefore records *which* products it contains; the price shown in `items[].salePrice` is the product's current sale price.

### 5.7 `DELETE stock/price-lists/products/{itemId}`
Removes one link row (`itemId` from 5.2). `200` «حُذفت السلعة من قائمة الأسعار.»; unknown ⇒ `404 PRICE_LIST_ITEM_NOT_FOUND`.

---

## Deliberate differences from the web

Correctness and safety choices made in the Node port:

| Area | Web | Node API |
|---|---|---|
| Approve outside the creator scope | The scope refusal is wrapped in the generic approval error message (422) | Plain `403 RECORD_FORBIDDEN` |
| Messages | PHP prints numbers; the 422 message lists the validation errors | Numbers printed without trailing zeros; `message` = the first error only (all errors in `details`) |
| Not found | Generic 404 page / `findOrFail` | Specific Arabic 404 messages and codes (`PERMIT_NOT_FOUND`, `WAREHOUSE_NOT_FOUND` …) |
| Update | Several writes without a transaction; status read once | One transaction; «pending» re-checked under a row lock |
| Update with a service/digital product | 500 from the stock guard | `422 STOCKLESS_PRODUCT` |
| Approve / reject / delete / cancel | Read-then-write: a double tap can approve twice and move stock twice | Permit row locked (`FOR UPDATE`) and stock rows locked; quantity moves are atomic (`quantity = quantity + ?`) — a triple-tapped approve moves stock once |
| Numeric / text ceilings | MySQL strict mode fails the insert with an SQL error | Node's MySQL session is non-strict (it would truncate silently), so `decimal(10,2)` money (≤ 99,999,999.99), `decimal(18,4)` quantity and `text` (≤ 65,535 bytes) limits are validated up front |
| Price list `status` | Not validated (fixed on the web to default 0 / keep existing) | Validated 0 / 1; defaults to 0 on create, keeps the existing value on update |
| Product stock | Bare JSON | Wrapped in `{ success, data: { stock, formatted } }` |
| Status codes | Redirects / 200 | `201` on create (permit, price list, list product) |
| Field names | snake_case form fields (`permission_type`, `store_houses_id`, `product_id[]`…) | camelCase (`permissionType`, `warehouseId`, `items[].productId` …) |
| Attachments | Written to the web server's disk | Uploaded to the ERP through `/api/mobile-media` — never stored on the Node host |
| Fawtra usage push | `PlanLimitObserver` marks usage for `UsagePush` | Not replicated — the limits are enforced from the snapshot + live count, but no usage is pushed to Fawtra from Node |
| Product stock quantity | First `product_details` row | Sum of the product's rows in the warehouse; warehouse scope checked (`403 WAREHOUSE_FORBIDDEN`) |
| Add product to price list | A missing price blanked the product's sale price | `salePrice` required; product must exist and be visible to the user |

Inherited from the Laravel integration copy (also true here):

| Area | Web | Node API |
|---|---|---|
| Delete | `delete()` does not look at the status — an approved permit is deleted and its quantities and entries stay | Approved permits refused (`PERMIT_APPROVED`) |
| `keywords` search | `LIKE '%…%'` with the text as typed — `%` or `_` in the search match anything | `%`, `_` and `\` are escaped, so they match themselves (`50%_off` finds only that name) |

---

## Web fixes made during the port

Bugs found in the Laravel web code while porting, fixed on the web as well (so both sides behave the same):

| File | Bug | Fix |
|---|---|---|
| `Modules/Stock/Http/Controllers/Stock/StorePermitsManagementController.php` — `update()` | Editing a **disbursement** blanked its warehouse: the edit form sends `store_houses_id`, the code read `from_store_houses_id` (absent), so the saved permit had no warehouse and its approval then failed. `from`/`to` were also kept on non-transfer permits | Disbursement uses `store_houses_id` (falls back to `from_store_houses_id`); `from`/`to` written only for transfers; the lines' `stock_before` is read from the permit's resulting warehouse |
| same — `store()` | Creation log lines were written with the **product id** as `type_id` instead of the permit id, so they appeared on unrelated permits | Logged with the permit id |
| same — `approve()` / `reject()` | Notifications were addressed to `$permit->user_id` — a column that does not exist — so they had no recipient | Addressed to `created_by` |
| `Modules/Stock/Http/Controllers/Stock/PriceListController.php` — `store()` / `update()` | Without `status` in the request the save failed with a raw SQL error (`price_lists.status` is NOT NULL) | Defaults to 0 on create, keeps the current value on update |
| `Modules/Stock/Http/Controllers/Reports/WarehouseStatementController.php` | Lines of one permit had no stable order, so the running balance could change between two loads | Tie-breaker on `warehouse_permits_products.id` (same in Node) |
| `database/migrations/2026_09_27_000001_add_stock_lookup_indexes.php` (new) | `logs.type + type_id` and the permit warehouse columns had no index: every warehouse-details load scanned the whole `logs` table | Indexes `logs(type, type_id)`, `warehouse_permits(store_houses_id, status)`, `warehouse_permits(from_store_houses_id)`, `warehouse_permits(to_store_houses_id)` (each only if the columns exist and the index is absent) — warehouse details went from ~4.7 s to ~0.1 s |
| `app/Http/Controllers/Api/MobileMediaController.php` | Accepted images only | Accepts JPEG / PNG / PDF ≤ 5 MB in `assets/uploads/warehouse` only (`DOCUMENT_FOLDERS`); all other folders unchanged (images only) |

---

## Developer notes

- Routes: `src/interfaces/http/routes/stock.ts` → `stockRoutes(container, auth)`, mounted by `buildRouter()` in `routes/index.ts` under `/api/v1` (behind the global `apiLimiter`). The multipart parser is the shared `upload` middleware of the Clients routes. Controllers only parse queries/ids and pick the status code; everything else is in the use cases.
- Path ids must be digits, else `404 NOT_FOUND`. Query strings are validated with zod (`parseQuery`) with Arabic messages; empty values count as absent. Bodies are read with `FormInput` (Laravel rules: empty string = null, numbers may arrive as strings).
- Any login-capable ERP user can call these endpoints (the Laravel integration copy is employees-only). For a non-employee the warehouse scope is the header branch only and the per-warehouse audience flags are `true`.
- Environment (see `.env.example`): `APP_TIMEZONE` (default `Asia/Riyadh`), `ERP_MEDIA_TOKEN` (shared secret with the ERP's `MOBILE_MEDIA_TOKEN`; without it attachments fail with `503`), `ERP_MEDIA_URL` (ERP base URL for uploads, defaults to `ERP_PUBLIC_URL`), `ERP_PUBLIC_URL` (base of file URLs), `ENFORCE_SUBSCRIPTION` (default `true`).
- Caches: subscription 60 s, plan features and plan usage 60 s, accounting-period settings 60 s, branch tree 30 s, application statuses `CACHE_TTL_SETTINGS`, role permissions `CACHE_TTL_PERMISSIONS`, notification settings 60 s. A permission or plan change on the web can take up to the TTL to be seen here. Everything scope-related is memoised per request only.
- Transactions: `KnexUnitOfWork`. Numbers are consumed inside the save transaction; an opening balance and its approval share one transaction; an attachment uploaded before a failed transaction is deleted on the ERP.
- Run the index migration on each database (`php artisan migrate --path=database/migrations/2026_09_27_000001_add_stock_lookup_indexes.php`) — without it warehouse details and the statement are slow on both web and Node.
- **Dev database caveat** — the `journal_entries` monthly quota is exhausted on the dev database (1730 entries created in September 2026 against an allowance of 1000), so every approval that writes an entry — and every opening-balance save — is refused on both the web and Node («فشل إنشاء القيد المحاسبي: بلغت حدّ …») until the quota renews or is raised. Permits with a zero amount (Σ quantity × unit price = 0) write no entry and are not affected.
- Postman: `docs/Stock.postman_collection.json` — folders Auth, Warehouses, Statement, Permits, Approval, Price lists. Log in first; `token`, `warehouse_id`, `product_id`, `permit_id`, `price_list_id` and `item_id` are saved automatically where possible.
