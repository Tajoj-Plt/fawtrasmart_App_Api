# FawtraSmart Mobile Backend (Node) — Clients — Detailed Reference

The field-sales part of the FawtraSmart mobile API served by the Node.js/Express backend in `MobileAppBackend/`: branches, clients, contacts and notes, the daily itinerary, the visit workspace, forgotten visits, visit justifications, notification detail/reply and location tracking. It runs against the **same MySQL database as the ERP** (Laravel) and writes the same rows the web writes.

| | |
|---|---|
| **Base URL** | `{{base_url}}/api/v1/` (default local `http://localhost:4000`) |
| **Format** | JSON in / JSON out. Every error — including unknown routes — is JSON |
| **Uploads** | `multipart/form-data` on the endpoints that take files (add/update client, add contact, notes, visit contact, visit note, competitors); `complete` / `cancel` / `start` accept JSON or multipart |
| **Auth** | `Authorization: Bearer {accessToken}` from `POST /api/v1/auth/login` (JWT, `JWT_ACCESS_TTL`, default 1 h; renew with `POST /api/v1/auth/refresh`) |
| **Field names** | camelCase in queries, bodies and responses (`clientTreeBranchId`, `currentLatitude`, `replyMessage` …) |
| **Language** | Arabic messages (validation messages name the field in Arabic) |
| **Permissions** | The same permission names as the matching web route (`permission.role:` on the web), read from the user's primary role (`users.role_id` → `role_has_permissions`) |

## Contents

1. [Implementation principle](#implementation-principle--a-standalone-typescript-port)
2. [Response shape and error codes](#response-shape-and-error-codes)
3. [Gates](#gates)
4. [Data scope — who sees what](#data-scope--who-sees-what)
5. [Settings that change behaviour](#settings-that-change-behaviour)
6. [Time, numbers, logs and notifications](#time-numbers-logs-and-notifications)
7. [The visit sequence](#the-visit-sequence)
8. [Uploads](#uploads)
9. [Endpoint index](#endpoint-index)
10. [Branches](#1-branches)
11. [Clients](#2-clients)
12. [Contacts and notes](#3-contacts-and-notes)
13. [Daily itinerary](#4-daily-itinerary)
14. [Forgotten visits](#5-forgotten-visits)
15. [Visit workspace](#6-visit-workspace)
16. [Visit justifications](#7-visit-justifications)
17. [Notifications](#8-notifications)
18. [Location tracking](#9-location-tracking)
19. [Role caveats on this database](#role-caveats-on-this-database)
20. [Deliberate differences from the web](#deliberate-differences-from-the-web)
21. [Developer notes](#developer-notes)

---

## Implementation principle — a standalone TypeScript port

Nothing here calls Laravel. Each operation is a **TypeScript port** of the web's controllers, services and model hooks (and of the Laravel integration copy in `Modules/Integration`) — same order of steps, same rules, same permission names, same Arabic messages — writing directly to the shared ERP tables through Knex. Model hooks that the web relies on (e.g. `EmployeeClientVisit::created` clearing the client's «استبعاد الموقع», `markStartedFor` / `markCompletedFor` on the itinerary row, `PlanLimitObserver` on notifications) are re-implemented explicitly where the write happens.

Layers (clean architecture):

| Layer | Clients code |
|---|---|
| Routes | `src/interfaces/http/routes/clients.ts` (mounted under `/api/v1` by `routes/index.ts`) |
| Controllers (query schemas, status codes, response wrapper) | `src/interfaces/http/controllers/clients/ClientsController.ts`, `VisitsController.ts` (+ `ItineraryController`), `FollowUpController.ts` |
| Use cases (permissions, validation, business rules, response shapes) | `src/application/use-cases/clients/` — `ClientUseCases`, `ClientStatusUseCases`, `ClientNotesUseCases`, `ItineraryUseCases`, `VisitUseCases`, `FollowUpUseCases`, `NotificationDetailUseCases`, `TrackingUseCases` |
| Shared application services | `src/application/services/clients/` — `ClientsContext` (gates + per-request context), `ClientVisibility`, `ClientForm`, `ClientNotesService`, `ClientPresenter`, `FormInput`, `ClientsSupport` (`ClientsLog`, `NotificationGate`, `CurrencyFormatter`) |
| Domain helpers | `src/domain/services/clients/` — `LocalTime`, `ClientSettings`, `BranchTree`, `ShiftRange`, `WeekCalendar`, `Geo`, `NotificationThreads`, `DocumentNumberFormat` |
| Infrastructure | `src/infrastructure/repositories/clients/Knex*Repository.ts`, `src/infrastructure/db/KnexUnitOfWork.ts`, `src/infrastructure/storage/LocalImageStore.ts`, `GoogleGeocoder.ts` |

Web source of each area:

| Node use case | Web source (`Modules\Client\Http\Controllers\…` unless noted) |
|---|---|
| `ClientUseCases` | `ClientController` — `index`, `getMapData`, `show`, `store`, `update`; `DataScope::branchOptions()`; `ClientSettingsHelper` |
| `ClientStatusUseCases` | `ClientController` — `updateStatusClient`, `updateStageClient` |
| `ClientNotesUseCases` | `ClientNoteController` — `storeEmployeeNote`, `getEmployeeNotes`, `addnotes`, `updateNote`, `destroyNote`, `deleteNoteAttachment` |
| `ItineraryUseCases` | `DailyItineraryService` / `DailyItineraryController`, `VisitWorkspaceController::returnToItinerary` |
| `VisitUseCases` | `VisitWorkspaceController` |
| `FollowUpUseCases` | `VisitController` (forgotten visits), `IncompleteVisitsController` (justifications) |
| `NotificationDetailUseCases` | `Modules\Sales\…\NotificationsController` — `show`, `reply` |
| `TrackingUseCases` | `ItineraryController::updateLocation`, `getMapData` |

---

## Response shape and error codes

Success (`ok()` / `okMessage()` in `src/interfaces/http/respond.ts`):

```json
{ "success": true, "data": { } }
{ "success": true, "message": "تمت إضافة العميل بنجاح.", "data": { } }
```

Reads return `{ success, data }`; writes return `{ success, message, data }`. Paginated lists put the page inside `data`:

```json
{ "success": true, "data": { "items": [ ], "total": 55, "page": 1, "perPage": 20, "lastPage": 3 } }
```

Errors (`errorHandler.ts`, `AppError`) always carry a machine `code` and an Arabic `message`; validation adds `details { field: [messages] }` (nested fields use dots: `contacts.0.email`, `competitors.1.photo`):

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "اختر مسؤول العميل الذي قابلته.", "details": { "clientEmployeeId": ["اختر مسؤول العميل الذي قابلته."] } } }
```

| HTTP | `code` | Meaning |
|---|---|---|
| 401 | `MISSING_TOKEN` / `INVALID_TOKEN` / `TOKEN_EXPIRED` / `TOKEN_REVOKED` / `USER_NOT_FOUND` | No/invalid/expired token, or the password changed since the token was issued |
| 402 | `NO_SUBSCRIPTION` / `SUBSCRIPTION_EXPIRED` / `SUBSCRIPTION_SYNC_LOCKED` / `SUBSCRIPTION_INACTIVE` | Subscription gate (`EnsureSubscription` messages) |
| 402 | `PLAN_FEATURE_UNAVAILABLE` | Plan does not include `notifications` (notification detail/reply) — `details.features` |
| 402 | `PLAN_LIMIT_REACHED` | Plan limit `internal_notifications` reached while an operation creates a notification — the whole operation is rolled back; `details { feature, remaining }` |
| 403 | `MODULE_DISABLED` | «العملاء» (`customers`) turned off in «شاشة التطبيقات» |
| 403 | `FORBIDDEN` | Missing route permission (or an extra action permission) |
| 403 | `CLIENT_FORBIDDEN` / `BRANCH_FORBIDDEN` | Client or branch filter outside the user's scope |
| 403 | `MUST_VISIT_FIRST` | «الزيارة قبل العرض»: open the visit before the file — `details { clientId, openVisitId }` |
| 403 | `VISIT_FINISHED_TODAY` | The client's visit is done today and hidden (return it to the itinerary first) |
| 403 | `SECTION_DISABLED` | «خطوط السير» section off in client module settings |
| 403 | `ITINERARY_FORBIDDEN` | Itinerary of a rep outside the user's team / no add rights |
| 403 | `RETURN_DISABLED` | «إرجاع العميل لخطّ السير» off in settings |
| 403 | `VISIT_FORBIDDEN` | Visit belongs to someone else (and the user is not a tracker/admin) |
| 403 | `SHIFT_LOCKED` | Changing a recorded contact shift without `clients_change_contact_shift` |
| 403 | `NOTE_FORBIDDEN` | Editing/deleting someone else's note with only the `_own` permission |
| 403 | `REPLY_FORBIDDEN` | Replying to a notification the user cannot see |
| 403 | `TRACKING_DISABLED` / `TRACKING_FORBIDDEN` | «تتبّع خط السير» off / employee outside the team |
| 404 | `NOT_FOUND` | Non-numeric id in the path |
| 404 | `CLIENT_NOT_FOUND` / `VISIT_NOT_FOUND` / `NOTE_NOT_FOUND` / `ATTACHMENT_NOT_FOUND` / `ROW_NOT_FOUND` / `NOTIFICATION_NOT_FOUND` / `JUSTIFICATION_NOT_FOUND` | Record not found (or not visible) |
| 404 | `ROUTE_NOT_FOUND` | Unknown path **or wrong HTTP method** (Express has no 405) |
| 413 | `PAYLOAD_TOO_LARGE` | JSON body over 4 MB |
| 422 | `VALIDATION_ERROR` | Validation (`details`); multipart limit errors also land here |
| 422 | `NO_CHANGE` | Status/stage already set (direct change) |
| 422 | `VISIT_NOT_STARTED` / `VISIT_CLOSED` | Step sent before «بدء الزيارة» / visit already completed or cancelled |
| 422 | `OUT_OF_RANGE` | Employee farther than the proximity radius (start / complete / cancel), or the client has no location |
| 422 | `STEPS_INCOMPLETE` | Complete sent before the mandatory steps — `details { steps }` |
| 422 | `NOTE_REQUIRED` / `STEP_DISABLED` / `COMPETITOR_DISABLED` | Competitor step before the note / capture off / existing competitor is inactive |
| 422 | `BAD_SIGNATURE` | Signature is not a real `data:image/…;base64,…` image |
| 422 | `TARGET_NOT_ALLOWED` / `DAY_LOCKED` / `NOTHING_ADDED` | Itinerary add refusals (`NOTHING_ADDED` carries the counters in `details`) |
| 422 | `NOT_POSTPONABLE` / `DAY_FULL` / `ALREADY_TOMORROW` | Postpone refusals |
| 422 | `NOT_FINISHED_TODAY` | Return-to-itinerary for a client not finished today |
| 422 | `EXEMPT` / `NOTHING_ACCEPTED` / `NO_JUSTIFICATION` / `ALREADY_APPROVED` | Justification refusals |
| 422 | `NO_COUNTERPART` | Notification reply with no other party |
| 422 | `NO_VALID_POINTS` | All tracking points outside the last 24 h / in the future |
| 429 | `RATE_LIMITED` | 240 requests/min per IP on `/api/v1`; tracking: 30 requests/min per user |
| 500 | `SAVE_FAILED` | Transaction failed — nothing was saved (logged to `error_logs`) |
| 503 | `UPLOADS_NOT_CONFIGURED` | `ERP_MEDIA_TOKEN` not set, so photos cannot be uploaded to the ERP |
| 502 | `MEDIA_UPLOAD_FAILED` | the ERP did not accept the photo (unreachable, wrong token, rejected) — nothing was saved |

---

## Gates

Applied by `ClientsContextFactory.load()` in the same order as the web middleware, before any logic:

1. `authenticate` — valid JWT and unchanged password (`401`).
2. Subscription (`EnsureSubscription`) — when `ENFORCE_SUBSCRIPTION=true` (default) the cached subscription snapshot must exist, not be expired and be active ⇒ otherwise `402` `NO_SUBSCRIPTION` / `SUBSCRIPTION_EXPIRED` / `SUBSCRIPTION_SYNC_LOCKED` / `SUBSCRIPTION_INACTIVE`.
3. Module `customers` (`EnsureModuleEnabled`) — «العملاء» in `application_settings` must be `active` ⇒ otherwise `403 MODULE_DISABLED`. **Skipped** for `GET branches` and the two notification routes (they are not «العملاء» screens on the web either).
4. Route permission (`permission.role:`) — any one of the listed alternatives ⇒ otherwise `403 FORBIDDEN`. Alternatives separated by `|` inside one string (e.g. `notifications_reply_to_notifications|data_scope_all`) behave like the web's `hasPermission()`.
5. Notification routes only: plan feature `notifications` (`plan:notifications`) ⇒ `402 PLAN_FEATURE_UNAVAILABLE`.
6. Inside the use case: scope (which client / visit / employee), ownership, extra action permissions, settings.

Any login-capable ERP user can call these endpoints (login itself refuses employees whose profile is deleted or who lack «دخول النظام»). Behaviour that differs for employees (`users.employee_id` set) is noted where it applies — e.g. the proximity check on notes and the automatic self-assignment on add client.

---

## Data scope — who sees what

**Clients** (`ClientVisibility`, port of `ClientAccessService` + `ClientController::index()`), first match wins:

1. `clients_view_all_clients` ⇒ all clients inside the user's current branch tree (`users.branch_id`; the main branch means no limit).
2. Otherwise the first permission the user holds of: `clients_view_by_daily_itinerary` (today's itinerary of the user and the users in his data scope) ← `clients_view_by_employee_groups` (clients whose neighbourhood lies in the employee's region groups) ← `clients_view_own_clients` (assigned clients, `client_employee`, for the employees in scope). No fall-through: an empty scope at the first matching permission means no clients.
3. Otherwise: an employee sees today's itinerary; a user with a branch sees the branch tree; anyone else sees nothing.

Then, for users without `clients_view_all_clients`, clients whose visit is finished today are hidden (setting «إخفاء العميل بعد إنهاء زيارته»); clients hidden from the user's map are always excluded.

`GET clients/map` follows the web map: a user with an itinerary today sees only that itinerary's clients (and finished ones are hidden even with view-all), each with `itinerarySource { tone: plan | self | other, label }`.

**Branch filter** — `branchId` narrows lists to a tree node with its descendants (`includeDescendants=0` for the node alone). A branch outside what `GET branches` returns ⇒ `403 BRANCH_FORBIDDEN` (never silently ignored).

**Single client** (show, update, options with `clientId`, status/stage, contacts, notes, open visit) — the same scope (`ClientVisibility.canAccess`) ⇒ `403 CLIENT_FORBIDDEN`.

**People** (another rep's itinerary, tracking path/team, forgotten visits `scope=all`, force-close/cancel of someone else's forgotten visit) — `TeamScope`: the data-scope ladder (`DataScope::documentUserIds()`) **plus** the user and everyone under him in the management hierarchy (`DataScopeService.accessibleUserIds`). `data_scope_all` / non-employees see everyone.

**Visits** — only the visit owner, a holder of `clients_visits_track`, or a user with the Spatie role `admin` can open/act on a visit (`403 VISIT_FORBIDDEN`).

---

## Settings that change behaviour

Read with `GET clients/settings`; enforced server-side on every call (settings rows cached 30 s).

| Setting (web screen) | Effect here |
|---|---|
| Required client fields (trade name, phone, mobile, email, tax number, CR, category, stage, location, image) | Validation of add/update client (`requiredFields`) |
| Unique phone / client type scope (`individual` / `commercial` / both) | Validation (`clientType` 1 / 2) |
| Default status / default registration stage | Applied on add |
| Status change requires approval | `POST clients/{id}/status` direct vs request (stage always needs `clients_approve_stage`) |
| «تتبّع خط السير» | All `tracking/*` endpoints (`TRACKING_DISABLED`) |
| Itinerary section on/off, max clients per day, lock after start, restrict to assigned clients, client-employee departments | `itinerary/*` |
| Visit proximity radius (global, overridable per user) | start / complete / cancel (`OUT_OF_RANGE`) and note location check |
| «استبعاد الموقع» (client exemption, when the section is on) + `clients_visit_any_location` (notes also `client_follow_up_add_notes_from_any_location`) | Location becomes optional and unchecked |
| Competitor capture on/off | Step 4 exists or is skipped (`competitorStep`) |
| Signature section on/off | `clientSignature` / `employeeSignature` required on complete |
| Note deposit count / note photo / min photos | Visit note and client note validation |
| Hide finished clients / allow return same day | Lists, `MUST_VISIT_FIRST`/`VISIT_FINISHED_TODAY`, `return-to-itinerary` |
| Max upload size (KB) | Every image field |
| Notification type settings (`notification_settings`) | A disabled type is not created (silently) |

---

## Time, numbers, logs and notifications

- **Time** — all times are written in the ERP timezone (`APP_TIMEZONE`, default `Asia/Riyadh`) as **naive local times** (`Y-m-d H:i:s`), exactly like Laravel writes them (`src/domain/services/clients/LocalTime.ts`). "Today", day boundaries, week numbers and the 4-hour forgotten-visit threshold are all computed in that zone. Tracking points sent with an explicit offset (`…Z`, `+03:00`) are converted to it; points without an offset are read as ERP local time.
- **Document numbers** — the client code (`serial_settings` section `customer`) and the visit number (section `visit`) are issued by `KnexDocumentNumberRepository`: the settings row is locked (`FOR UPDATE`) inside the save transaction, numbers already taken in the document table are skipped, and periodic resets are honoured. Any `code` sent by the app is ignored. `GET clients/options` returns `nextCode` as a preview only.
- **Activity log** — every write records a row in `logs` (activity screen) and one in `event_logs` (`KnexOperationLogRepository`, port of `OperationLog::record()`), with user, IP, user agent and route (`api.clients.<action>`); descriptions end with «— من تطبيق الجوال». Failures go to `error_logs` (+ `event_logs`). Log modules match the web: `Clients`, `ClientItineraries`, `ClientVisitWorkspace`, `ClientVisits`, `VisitJustification`.
- **Notifications** — every notification created (status/stage requests, client note, visit arrival/departure, forgotten visit closed, justifications to managers, replies) goes through `NotificationGate`: the type must be enabled in `notification_settings`, and the plan limit `internal_notifications` is checked (`402 PLAN_LIMIT_REACHED`, rolling the operation back when inside a transaction). Arrival/departure and manager notifications are best-effort — their failure is logged, not returned.

---

## The visit sequence

```
open ─► start (GPS in range) ─► contact ─► contact-shift ─► note ─► competitors ─► complete
  │                                                                              ▲
  └─────────────────────────────── cancel (reason + GPS, any time) ─────────────┘
```

- `open` returns today's open visit of this user for this client, or creates one (`visitNumber` server-issued) — `201` with a message when created, `200` without a message when it already existed. A visit recorded by automatic tracking is adopted (`recording_method = manual`). Nothing else is writable before `start`.
- `start` needs `currentLatitude/currentLongitude` within the owner's proximity radius of the client location (unless exempt). No client location ⇒ `422 OUT_OF_RANGE` with a clear message (cancel is the way out). A repeated `start` ⇒ `200` «الزيارة بدأت من قبل.» with the running timer.
- `steps` (in every step response and in `GET visits/{id}`) is the single source the app should read:

```json
"steps": { "hasContact": true, "hasShift": true, "hasNote": true, "competitorStep": true,
           "hasCompetitors": true, "docsUnlocked": true, "hasSale": false,
           "canComplete": true, "canReturn": true, "outcome": "failed" }
```

- The note step can carry `shift` to set it (first time) or change it (with `clients_change_contact_shift`); the shift is written only after the note is saved. If the contact has no shift and none is sent ⇒ `422`.
- `docsUnlocked` tells the app it may now open invoice / receipt / credit note / exchange screens for this client.
- `complete` has no manual outcome: an invoice or a receipt/collection created by the employee since `startedAt` ⇒ `success`, otherwise `failed`. `returnLater=true` + `returnTime=HH:MM` needs only contact + shift + note (`canReturn`), and puts the client back in today's itinerary.
- Every write on a completed/cancelled visit ⇒ `422 VISIT_CLOSED`.
- `toggle-pause` is meant to be called by the app on geofence exit/enter (the web does it automatically). `elapsedSeconds` excludes paused time.

---

## Uploads

Photos never stay on this server: they are compressed here and uploaded to the ERP (`POST {ERP_MEDIA_URL}/api/mobile-media`, Laravel `AppHttpControllersApiMobileMediaController`, header `X-Media-Token` = shared secret `ERP_MEDIA_TOKEN` / `MOBILE_MEDIA_TOKEN`). The ERP accepts only the folders below, safe generated file names with an image extension, real image content, and never overwrites a file. Deleting a replaced/rolled-back photo calls `POST /api/mobile-media/delete`.

| Field | Endpoint | Rule | Stored in (ERP `public/`) |
|---|---|---|---|
| `attachments` | add/update client | jpeg/png/gif ≤ max upload (required on add when the image field is enabled) | `assets/uploads/` (stored as is) |
| `attachments[]` (also `attachments`, `attachments[0]`) | client note, update note, visit note | jpeg/png ≤ max upload, min photos from settings, max 10 | `assets/uploads/notes/` |
| `image` | client contact, visit contact | jpeg/png/gif ≤ max upload | `uploads/client_notes/` |
| `competitors[i][photo]`, `noCompetitorsPhoto` | competitors | jpeg/png/webp ≤ max upload | `assets/uploads/visit_competitors/` |
| `clientSignature`, `employeeSignature` | complete (text fields) | `data:image/…;base64,…`, ≤ 3 000 000 chars, must decode to a real image | `assets/uploads/visit_signatures/` |

- The file type is detected from the content (magic bytes), not the name or MIME header.
- JPEG/PNG photos are compressed like the web's `compressAndSaveImage()` (max 1920 px, JPEG quality 75→40 by size). File names are generated (`<unix>_<hex>.jpg`) — never taken from the upload.
- Multer technical caps: 25 MB per file, 40 files, 300 fields, 4 MB per text field; the effective size limit is «الحد الأقصى للرفع» from settings. Exceeding a multer cap ⇒ `422 VALIDATION_ERROR`.
- Nested multipart fields use bracket notation: `contacts[0][firstName]`, `employeeClientIds[]`, `competitors[0][competitorId]`, `competitors[0][photo]`, `attachments[0]`.
- Files uploaded before a failed transaction are deleted again on the ERP.

---

## Endpoint index

| # | Method | Path | Permission |
|---|---|---|---|
| 1.1 | GET | `branches` | — |
| 2.1 | GET | `clients/settings` | — |
| 2.2 | GET | `clients/options` | `clients_add_client` / `clients_edit_data` |
| 2.3 | GET | `clients/map` | view clients |
| 2.4 | GET | `clients` | view clients |
| 2.5 | POST | `clients` | `clients_add_client` |
| 2.6 | GET | `clients/{id}` | view clients |
| 2.7 | POST | `clients/{id}` | `clients_edit_data` |
| 2.8 | GET | `clients/{id}/status-options` | `clients_change_status` |
| 2.9 | POST | `clients/{id}/status` | `clients_change_status` |
| 2.10 | POST | `clients/{id}/stage` | `clients_change_status` |
| 3.1 | GET | `clients/{id}/contacts` | view notes |
| 3.2 | POST | `clients/{id}/contacts` | add notes |
| 3.3 | GET | `clients/{id}/notes` | view notes |
| 3.4 | POST | `clients/{id}/notes` | add notes |
| 3.5 | POST | `notes/{id}` | edit notes |
| 3.6 | DELETE | `notes/{id}` | edit notes |
| 3.7 | DELETE | `notes/{id}/attachments/{index}` | edit notes |
| 4.1 | GET | `itinerary/day` | itinerary view |
| 4.2 | GET | `itinerary/employees` | itinerary view |
| 4.3 | GET | `itinerary/clients` | itinerary add |
| 4.4 | POST | `itinerary/clients` | itinerary add |
| 4.5 | POST | `itinerary/{rowId}/postpone` | `clients_itinerary_edit` |
| 4.6 | POST | `clients/{id}/return-to-itinerary` | workspace |
| 5.1 | GET | `visits/forgotten` | `clients_view_forgotten_visits_own` / `clients_view_forgotten_visits_all` |
| 5.2 | POST | `visits/forgotten/{id}/close` | `clients_close_forgotten_visits_own` / `clients_force_close_forgotten_visits` |
| 5.3 | POST | `visits/forgotten/{id}/cancel` | `clients_cancel_forgotten_visits` |
| 6.1 | POST | `clients/{id}/visits/open` | workspace |
| 6.2 | GET | `visits/{id}` | workspace |
| 6.3 | POST | `visits/{id}/start` | workspace |
| 6.4 | POST | `visits/{id}/toggle-pause` | workspace |
| 6.5 | POST | `visits/{id}/contact` | workspace + add notes |
| 6.6 | POST | `visits/{id}/contact-shift` | workspace |
| 6.7 | POST | `visits/{id}/notes` | workspace + add notes |
| 6.8 | POST | `visits/{id}/competitors` | workspace + add notes |
| 6.9 | POST | `visits/{id}/competitors/quick` | workspace + add notes |
| 6.10 | POST | `visits/{id}/notifications/{nid}/read` | workspace |
| 6.11 | POST | `visits/{id}/notifications/{nid}/reply` | workspace + `notifications_reply_to_notifications` |
| 6.12 | POST | `visits/{id}/complete` | workspace + `clients_visit_complete` |
| 6.13 | POST | `visits/{id}/cancel` | workspace + `clients_visit_cancel` |
| 7.1 | GET | `visit-justifications/pending` | — |
| 7.2 | POST | `visit-justifications` | — |
| 7.3 | GET | `visit-justifications` | `clients_visit_justifications_view_own` / `clients_visit_justifications_view_all` |
| 7.4 | GET | `visit-justifications/{id}` | same as 7.3 |
| 7.5 | PUT | `visit-justifications/{id}` | same as 7.3 |
| 8.1 | GET | `notifications/{id}` | `sales.notifications.view` |
| 8.2 | POST | `notifications/{id}/reply` | `sales.notifications.reply` **and** `notifications_reply_to_notifications` / `data_scope_all` |
| 9.1 | POST | `tracking/location` | `clients_itinerary_edit` |
| 9.2 | GET | `tracking/path` | `clients_itinerary_view` / `clients_view_by_daily_itinerary` |
| 9.3 | GET | `tracking/team` | `clients_itinerary_view` / `clients_view_by_daily_itinerary` |

*view clients* = `clients_view_all_clients | clients_view_own_clients | clients_view_by_employee_groups | clients_view_by_daily_itinerary` ·
*workspace* = `clients_visits_track | clients_itinerary_add | clients_visit_workspace_access | clients_must_visit_before_view` ·
*view / add / edit notes* = `client_follow_up_{view|add|edit_delete}_notes_attachments_appointments_{all|assigned|own}` (add also `clients_add_employee_note`) ·
*itinerary view* = `clients_daily_itinerary_view | clients_daily_itinerary_add_for_others` ·
*itinerary add* = `clients_daily_itinerary_add_client | clients_daily_itinerary_add_for_others`.

The route order in `routes/clients.ts` matters: `visits/forgotten` is declared before `visits/:visit` so it is not captured as a visit id.

---

## 1) Branches

### 1.1 `GET branches`

Branch-tree nodes the user may filter by (`?search=` optional, max 100 chars). `currentBranchId` is the branch selected in the web header — the default scope when no `branchId` is sent. `restricted=false` means the whole organisation. Main branch first, then by code.

```json
{ "success": true, "data": { "currentBranchId": 4, "restricted": true,
  "branches": [ { "id": 4, "name": "منطقة الشرقية", "code": "B2", "parentId": 1, "nodeType": "region", "typeLabel": "منطقة", "isMain": false, "isCurrent": true } ] } }
```

---

## 2) Clients

### 2.1 `GET clients/settings`
See [Settings](#settings-that-change-behaviour). `proximityMeters` is the user's own radius. `shift.hours[]` (`{ value: "08:00", label }`) feeds the «from/to» pickers; send `full` or `HH:00|HH:00`. `siteTypes` = `independent_booth, grocery, supplies, markets, station`.

### 2.2 `GET clients/options`
Everything the add/edit form needs. `branchTree[]` is flat (`parentId`); only `selectable=true` nodes may be sent as `clientTreeBranchId` (the intersection of the header branch and the employee's region groups; an empty intersection falls back to the region groups). `employees[]` is filled only for users with `clients_assign_employees` (departments from settings). `nextCode` is a preview (null with `clientId`). `?clientId=` keeps an existing client's current node selectable (with its ancestors shown as non-selectable).

### 2.3 `GET clients/map`
Same filters as the list; returns only clients with a location (max 2000) plus `branchPath` and `itinerarySource`. `itineraryOnly=true` when the user has an itinerary today.

### 2.4 `GET clients`

Filters (all optional; empty values are ignored): `search` (name, code, phone, mobile), `branchId` + `includeDescendants` (`1/0/true/false/on/off`), `region` (tree node), `client` (id), `name`, `status` (id / `no_status`), `registrationStage`, `categoryId`, `type` (1 individual / 2 commercial), `neighborhood`, `employee`, `overCreditLimit`, `customerTargetId` (id / `no_target`), `dateFrom`, `dateTo` (`YYYY-MM-DD`), `lastInvoicePeriod` · `lastPaymentPeriod` · `lastActivityPeriod` (`today, week, two_weeks, month, three_months, six_months, year, more_than_year`), `sort` (`newest` default / `name`), `latitude`+`longitude` (both or neither; adds `distanceKm`), `perPage` 1–100 (default 20), `page`.

```json
{ "id": 11034, "code": "C-0412", "tradeName": "بقالة النور", "phone": "0500000001", "mobile": null,
  "status": { "id": 1, "name": "نشط", "color": "#28c76f" }, "branch": { "id": 4, "name": "منطقة الشرقية" },
  "neighborhood": "حي الاختبار", "location": { "latitude": 24.7136, "longitude": 46.6753 },
  "balance": 1250.5, "balanceFormatted": "1,250.50 ر.س", "balanceDirection": "debit",
  "needsVisit": true, "openVisitId": null, "distanceKm": 0.42 }
```

`balance` is the sum of the client's ledger accounts (`> 0` = the client owes, `debit`); `balanceFormatted` uses the default currency settings. `needsVisit` / `openVisitId` — for users bound by «الزيارة قبل العرض» (`clients_must_visit_before_view` without `clients_exempt_visit_before_view`): tap the row ⇒ open the visit, not the file.

### 2.5 `POST clients` (multipart)
Fields are exactly the web form: `clientTreeBranchId`*, `tradeName`, `firstName`, `lastName`, `phone`, `mobile`, `email`, `categoryId`, `registrationStageId`, `clientType`, `taxNumber`, `commercialRegistration`, `currency`, `printingMethod` (1/2), `street1`, `street2`, `city`, `region`, `postalCode`, `country`, `notes`, `latitude`, `longitude`, `neighborhoodNameManual`, `attachments` (file), `employeeClientIds[]`, `contacts[i][firstName|lastName|email|phone|mobile]` (max 20). Which ones are required comes from settings. `code`, `statusId`, credit limit, opening balance, password… are not accepted.

Side effects, in one transaction: client code, default status and stage, primary contact (from the trade name/phone/email), assignment (chosen `employeeClientIds` with `clients_assign_employees`, else the creator if he is an employee), location, neighbourhood (manual name, else Google reverse geocoding when `GOOGLE_MAPS_API_KEY` is set, else «غير محدد»), client login account when an email is given (random password), ledger account under «حساب العملاء», activity log. With `clients_start_visit_on_create` (and a workspace permission) the client enters today's itinerary and a visit is opened in a second transaction — its id is returned as `data.visitId` (a failure there does not undo the client).

```json
{ "success": true, "message": "تمت إضافة العميل وفتح زيارته — أضِف مسؤول العميل لتبدأ.", "data": { "id": 11034, "code": "C-0412", "tradeName": "بقالة النور", "…": "…", "visitId": 15905 } }
```

### 2.6 `GET clients/{id}`
Full file (summary + contact/address/tax fields, `category`, `registrationStage`, `branchPath`, `treeNodeId`, `attachmentUrl`, `assignedEmployees[]`, `contacts[]`, `createdAt`) and `can { edit, changeStatus, addNote, viewNotes, openVisit }`. Answers `403 MUST_VISIT_FIRST` (with `details.openVisitId`) or `403 VISIT_FINISHED_TODAY` exactly where the web redirects.

### 2.7 `POST clients/{id}` (multipart)
Same fields as add + `itemQuantityLimit` (≥ 0) + `contacts[i][id]` (existing contacts are updated, the list is synced only when `contacts` is sent). Only the fields present in the request are written. `attachments` optional (the old photo is deleted after commit). The location is replaced only when `latitude/longitude` are sent; the neighbourhood is refreshed when the location/manual name/territory changes. Assignments are replaced only when `employeeClientIds` is sent (with `clients_assign_employees`); an employee without that permission is ensured as assigned. The login user and ledger account name are kept in sync.

### 2.8–2.10 Status and stage
`status-options` tells whether approval is needed and who can approve (`statusApprovers` / `stageApprovers` = users holding `clients_approve_status` / `clients_approve_stage`). Without approval rights the change becomes a `pending` row in `client_status_requests` / `client_stage_requests` addressed to `managerId` (who must hold the approval permission, else `422`) and a notification (`client_status_request` / `client_stage_request`) is sent; with rights it applies immediately and is stored as an `approved` request. `notes` ≤ 1000 chars. `visitId` (optional, must be a visit of this client) prefixes the reason with `[من زيارة <number> بتاريخ <date>]`. `stageId` empty = «بلا وضع».

```json
POST clients/11034/status   { "statusId": 2, "managerId": 163, "notes": "المحل مغلق", "visitId": 15905 }
→ { "success": true, "message": "رُفع طلب تغيير الحالة للمسؤول وأُشعِر به.", "data": { "clientId": 11034, "statusId": 1, "pendingApproval": true } }
```

---

## 3) Contacts and notes

### 3.1–3.2 Contacts (client staff)
`employeeName`* (≤ 255), `employeePhone`* (≤ 20), `shift`* (`full` or `HH:00|HH:00`, whole hours, start ≠ end), `employeePosition` (default «موظف»), `isPrimary` (boolean), `invoiceId` (must belong to the client), `image` (file). Returned shape: `{ id, employeeName, employeePosition, employeePhone, isPrimary, shift, shiftStart, shiftEnd, shiftLabel, imageUrl, invoiceId, invoiceCode, createdBy, createdAt }`.

### 3.3 `GET clients/{id}/notes`
Paginated (`page`, `perPage` default 15). Users with only the `_own` view permission see their own notes. Each note has `attachments[{ index, url }]` — `index` is what `DELETE notes/{id}/attachments/{index}` expects — `competitors[]` observed with it, and `canEdit`.

### 3.4 `POST clients/{id}/notes` (multipart)
`clientEmployeeId`* (a contact of this client), `description`* (≤ 5000), `depositCount` (0–100000; required when the setting is on), `attachments[]` (min photos when the photo setting is on, max 10), `currentLatitude/currentLongitude` (required unless exempt), optional `shift` (else the contact's own shift; if the contact has none ⇒ `422`), `process` (≤ 255), `siteType` (default `markets`).
For employees who are not exempt, the position must be within the user's proximity radius of the client's registered location — refused as `422 VALIDATION_ERROR` on `currentLatitude` («يجب أن تكون ضمن نطاق … كم من العميل — المسافة الحالية: … كم.»). The stored description is `"<text> | دوام المسؤول: <shift> | عدد العهدة: <n>"`. The note notifies the author (`client_note`), stamps `clients.last_note_at`, and stores the employee position with the note (`locations.client_relation_id`).

### 3.5–3.7 Update / delete
`_all` edits any note, `_own` only the user's notes — and only for clients in scope (`NOTE_FORBIDDEN` / `CLIENT_FORBIDDEN`). Update requires `clientEmployeeId`, `description`, `depositCount`, `siteType`, `competitorDocuments`, `shift` (no location check) and appends new `attachments[]` to the existing ones. Delete removes the note and its photos; delete-attachment returns `remaining`.

---

## 4) Daily itinerary

`employeeId` here is a **user id** (the itinerary table `employee_client_visits.employee_id` stores `users.id`). All itinerary routes answer `403 SECTION_DISABLED` when «خطوط السير» is off.

### 4.1 `GET itinerary/day?date=&employeeId=`
Port of `DailyItineraryService::day()`: ordered `stops[]` (visited first by time, then active, then the plan, cancelled last) with `state` (`next`, `planned`, `late`, `active`, `done`, `missed`, `cancelled`), estimated `start/end` (from 08:00, 30 min per visit, 30 km/h legs; the rest of today counted from now), `legKm/legMinutes`, `addedBy { id, name, role, self }`, latest `note` and up to 8 `photos`, and `stats { done, total, percent, km, minutes }`. Another rep's day needs `clients_daily_itinerary_add_for_others` or `clients_itinerary_view` **and** the rep in the team. `can.start` is true only for the user's own today.

### 4.2 `GET itinerary/employees`
The user first, then reps in his data scope / client-employee departments / header branch, plus his team. Without "view others" rights only the user himself.

### 4.3 `GET itinerary/clients?employeeId=&date=&nodeId=&q=`
Picker (max 100) limited to the user's selectable nodes and header branch; `inRoute` marks clients already open on that day; `nodes[]` feeds a «تابع لـ» filter.

### 4.4 `POST itinerary/clients`
`{ "clientIds": [11034, 11035], "employeeId": 57, "date": "2026-09-28" }` (`employeeId`, `date` optional; date today or later). Adding respects the target's department/header branch (`TARGET_NOT_ALLOWED`), the lock after the first started visit for someone else's day (`DAY_LOCKED`), scope, «assigned clients only», already-open rows and the day cap. Rows are appended to the end of the day (`added_by` = the user). Skipped clients are counted in `data` (`already`, `outOfScope`, `unassigned`, `full`); if none was added ⇒ `422 NOTHING_ADDED` with the counters in `details`.

### 4.5 `POST itinerary/{rowId}/postpone`
Only a planned visit of today or later, moved to the end of tomorrow's line (`is_moved`, `moved_from_*`), cap-checked (`DAY_FULL`) and not duplicated (`ALREADY_TOMORROW`).

### 4.6 `POST clients/{id}/return-to-itinerary`
For a client whose visit the user finished today and that got hidden — adds an open itinerary row so it can be visited again (needs «allow return same day», else `403 RETURN_DISABLED`).

---

## 5) Forgotten visits

A visit is forgotten when it is still open (no departure time) and either started more than **4 hours** ago, or was opened on a previous day and never started. `GET visits/forgotten?scope=own|all` returns up to 200; `scope=all` needs `clients_view_forgotten_visits_all` and returns the user's team (otherwise it silently falls back to `own`).

- **Close** (`notes` optional, ≤ 1000): own visit needs `clients_close_forgotten_visits_own`; someone else's needs `clients_force_close_forgotten_visits` + the owner in the team, and notifies the owner (`forgotten_visit_closed`). Writes `stage=completed`, `outcome=successful`, `departure_time`; the itinerary row's duration is written only when it is reasonable (≤ 4 h).
- **Cancel** (`cancelReason`* ≤ 500): needs `clients_cancel_forgotten_visits`; cancelling another employee's visit is for users whose role name is `admin` / `manager`, within the team. Writes `stage=cancelled` and `departure_time`.

---

## 6) Visit workspace

See [The visit sequence](#the-visit-sequence). `GET visits/{id}` (and `open`) return the whole screen in one call:

| Key | Content |
|---|---|
| `visitId, stage, startedAt, paused, elapsedSeconds` | Timer (`arrived → in_progress ⇄ paused → completed / cancelled`) — also the whole `data` of `start` / `toggle-pause` |
| `visitNumber, visitDate, departureTime, outcome, cancelReason, employee` | Visit header |
| `client`, `clientLocation` | Client summary and the coordinates the distance is measured against (saved with the visit, else the client location) |
| `steps` | Mandatory steps (source of truth) |
| `rules` | `proximityMeters` (owner's radius), `anyLocation`, `competitorCapture`, `signatureRequired`, `noteDepositCount`, `notePhoto`, `noteMinPhotos`, `maxUploadKb` |
| `can` | `complete`, `cancel`, `changeShift`, `replyNotifications`, `changeStatus`, `statusNeedsApproval`, `stageNeedsApproval` (+ `statusApprovers[]`, `stageApprovers[]`) |
| `contacts[]`, `notes[]` (last 20), `competitorsObserved[]`, `competitorOptions[]` | Step data |
| `clientNotifications[]` | Management notes about this client addressed to the user, with `replies[]` |
| `visitDocuments[]` | Documents created in this visit window by the rep (or the viewer) — only after start |
| `clientDocuments{}` | Last 20 per group: `invoices, returns, receipts, expenses, credit_notes, exchanges` — `{ group, type, id, number, amount, at }` (+ `paymentStatus` on invoices) |

Step payloads:

- **contact** (multipart) — same fields as 3.2; `201` `data = { …contact, steps }`.
- **contact-shift** — `{ "clientEmployeeId": 88, "shift": "08:00|16:00" }`; `data = { …contact, steps }`.
- **notes** (multipart) — same fields as 3.4 (the shift rule above); `201` `data = { noteId, steps }`.
- **competitors** (multipart) — `422 STEP_DISABLED` when capture is off, `422 NOTE_REQUIRED` before a visit note. Competitors already recorded for this visit/note are skipped; `data = { saved, steps }`.

```
competitors[0][competitorId]=7
competitors[0][assetCount]=2
competitors[0][photo]=<file>
— or —
noCompetitors=1
noCompetitorsPhoto=<file>
```

- **competitors/quick** — `{ "name": "شركة المنافس" }`; returns the existing competitor (`200`, `existed: true`) or creates it (`201`).
- **notifications/{nid}/read** — the notification must be a client notification of this visit's client addressed to the user.
- **notifications/{nid}/reply** — `{ "replyMessage": "…" }` (≤ 500) to the sender; marks the original read.
- **complete**:

```json
{ "currentLatitude": 24.7136, "currentLongitude": 46.6753, "outcomeNotes": "",
  "returnLater": true, "returnTime": "18:30",
  "clientSignature": "data:image/png;base64,…", "employeeSignature": "data:image/png;base64,…" }
→ { "success": true, "message": "انتهت الزيارة — زيارة سلبيّة (بلا فاتورة ولا تحصيل). وسُجّلت لك عودةٌ إليه اليوم.",
    "data": { "visitId": 15905, "outcome": "failed", "durationMinutes": 23, "returnLater": true } }
```

- **cancel** — `{ "cancelReason": "المحل مغلق", "currentLatitude": 24.7136, "currentLongitude": 46.6753 }` (reason ≤ 255); allowed before start too.

Start and complete send an arrival/departure notification (`visit`) and update the itinerary row (`started` / `completed` with duration).

---

## 7) Visit justifications

Yesterday-and-older itinerary visits that were not done need a written justification that management approves. Holders of `staff_visit_justification_exempt` get `exempt: true` and cannot submit (`422 EXEMPT`). The API does not block other screens — the app should read `pendingCount` at start-up and prompt.

The id used everywhere is the itinerary row id (`employee_client_visits.id`).

```json
POST visit-justifications   { "justifications": { "58753": "العميل كان مغلقاً طوال اليوم" } }
→ { "success": true, "message": "قُدّم 1 تبرير — ستراجعه الإدارة.", "data": { "submitted": [58753], "rejected": [] } }
```

- Text 5–**250** characters (the column is `varchar(250)`), max 200 entries.
- Only visits currently waiting for the user's justification are accepted; others go to `rejected`. None accepted ⇒ `422 NOTHING_ACCEPTED` (`details.rejected`). Users with role `admin` / `manager` are notified.
- `GET visit-justifications` — the user's submitted justifications (`status`: `pending` / `approved` / `rejected`), paginated (default 15), plus the exemption `periods[]` granted to him.
- `PUT visit-justifications/{id}` — `{ "justification": "…" }`; a rejected justification goes back to pending; an approved one cannot be edited (`ALREADY_APPROVED`); nothing submitted yet ⇒ `NO_JUSTIFICATION`.

---

## 8) Notifications

In-app notifications only — **there is no push** (none exists in the ERP either). Only two notification routes belong to this section:

- `GET notifications/{id}` — a notification the user sent or received. Opening it marks it read (if the user is the receiver) and returns its `replies[]` (linked by `parent_id`, with the web's legacy title-matching for older replies, computed for this notification only) and, for status requests/decisions, `decision { text, byId, byName, at }`.
- `POST notifications/{id}/reply` — `{ "replyMessage": "…" }` (≤ 500) goes to the other party (`type: reply`, `parent_id` set) and marks the original read. `201` `data = { id, replyTo }`.

Both require the plan feature `notifications` (`402 PLAN_FEATURE_UNAVAILABLE`) and the web permissions (`sales.notifications.view`; reply: `sales.notifications.reply` **and** `notifications_reply_to_notifications|data_scope_all`). They skip the «العملاء» module gate.

The list, unread count and mark-read endpoints are the pre-existing ones in `routes/index.ts` (`GET notifications`, `GET notifications/unread-count`, `POST notifications/mark-read`, `POST notifications/mark-all-read`) — unchanged, see [Deliberate differences](#deliberate-differences-from-the-web). Client notifications are also delivered inside the visit (6.10 / 6.11), where reps without `sales.notifications.view` can read and answer them, as on the web.

---

## 9) Location tracking

- **Send**: `POST tracking/location` with `{ "latitude": 24.7136, "longitude": 46.6753 }` every ~15 s while working (as the web header does), or `{ "points": [ { "latitude", "longitude", "recordedAt" } ] }` (≤ 100) to upload what was collected offline. Points older than 24 h or more than 2 min in the future are rejected (`rejected` count; all rejected ⇒ `422 NO_VALID_POINTS`); a point closer than 2 m **and** within 60 s of the previous one is skipped (web rule). Points go to `employee_tracking`; the newest becomes the user's current position in `locations` (row without client). Throttle: 30 requests/minute per user (`429 RATE_LIMITED`).
- **Path**: `GET tracking/path?date=&employeeId=` — the day's points in order, total `distanceKm`, `pointsCount`, and the `current` position (`isLive` = updated in the last 15 minutes). Another employee must be in the team (`TRACKING_FORBIDDEN`).
- **Team**: `GET tracking/team` — latest position of every team member seen in the last 24 hours, `isMe` for the user.

All three answer `403 TRACKING_DISABLED` when «تتبّع خط السير» is off.

---

## Role caveats on this database

Observed on the current ERP database for the sales-rep role (id 3 «مندوب مبيعات»):

- It holds `staff_visit_justification_exempt`, so `GET visit-justifications/pending` returns `exempt: true` and submit/update answer `422 EXEMPT`.
- It lacks `clients_itinerary_edit` ⇒ reps cannot send tracking locations (`POST tracking/location` → `403`) or postpone itinerary visits. On the web the header GPS of reps is silently refused for the same reason. Grant it to the role to enable tracking.
- It lacks `sales.notifications.view` ⇒ `GET notifications/{id}` / reply are `403`; reps read and answer client notifications from inside the visit.
- It lacks the forgotten-visits permissions (`clients_view_forgotten_visits_*`, `clients_close_forgotten_visits_own`, `clients_force_close_forgotten_visits`, `clients_cancel_forgotten_visits`) ⇒ all `visits/forgotten*` routes are `403`.

---

## Deliberate differences from the web

Correctness and safety fixes made in the Node port (the web is unchanged):

| Area | Web | Node API |
|---|---|---|
| Visit start / complete / cancel | Read-then-write: a double tap can start or close a visit twice | Atomic conditional update (`WHERE departure_time IS NULL [AND started_at IS NULL]`): the second tap gets «بدأت من قبل» / `VISIT_CLOSED` |
| Open visit | Two parallel taps can create two visits | The client row is locked (`SELECT … FOR UPDATE`) inside the transaction, so parallel taps create one visit |
| Client login user without phone | `users.phone` NOT NULL ⇒ the save crashes when an email is given without a phone | `users.phone` written as `''` |
| Justification length | Validates 1000 chars, then fails at the database (`employee_client_visits.justification` is `varchar(250)`) | Capped at 250 characters in validation |
| Replaced client photo | Old file deleted inside the save (lost if the transaction rolls back) | Deleted only after the transaction commits |
| Points / loyalty | Points awarded on client add, notes… | **Not implemented** (left out on request) |
| Push notifications | None in the ERP | None — in-app notifications only |
| Notification list / count / mark-read | `sales.notifications.view` (+ plan feature) | The pre-existing Node endpoints `/notifications`, `/notifications/unread-count`, `/notifications/mark-read`, `/notifications/mark-all-read` were left unchanged and have **no permission gate** (looser than the web). The new `GET /notifications/:id` and `POST /notifications/:id/reply` use the web's gates |

Inherited from the Laravel integration copy (also true here):

| Area | Web | Node API |
|---|---|---|
| Add/update client | Fills the model from the whole request (status, code, password… are fillable) | Only the form's validated fields; code always server-issued; credit limit / opening balance not accepted |
| Update client | No scope check; wipes the location when not sent | Scope checked; location kept unless sent |
| Contact / note contact id | Any contact id of any client | Must belong to the client |
| Visit steps after completion | Still writable | `422 VISIT_CLOSED` |
| Signature | Any string written to disk as PNG | Must decode to an image (`BAD_SIGNATURE`) |
| Cancel forgotten visit | No departure time — could be re-opened as "today's open visit" | Closed properly |
| Forgotten visits `scope=all` | Whole organisation | The user's team / data scope |
| Justification submit | Any visit id of the user | Only visits waiting for justification; managers notified |
| Notification detail | Recomputes every reply thread in the system per request | Same result, computed for this notification only |

---

## Developer notes

- Routes: `src/interfaces/http/routes/clients.ts` → `clientRoutes(container, auth)`, mounted by `buildRouter()` in `routes/index.ts` under `/api/v1` (behind the global `apiLimiter`). Controllers only parse queries/ids and pick the status code; everything else is in the use cases.
- Path ids must be digits, else `404 NOT_FOUND`. Query strings are validated with zod (`parseQuery`) with Arabic messages; empty values count as absent. Bodies are read with `FormInput` (Laravel rules: empty string = null, numbers may arrive as strings, booleans accept `true/false/1/0`).
- Environment (see `.env.example`): `APP_TIMEZONE` (default `Asia/Riyadh`), `ERP_MEDIA_TOKEN` (shared secret with the ERP's `MOBILE_MEDIA_TOKEN`; without it uploads fail with `503`), `ERP_MEDIA_URL` (ERP base URL for uploads, defaults to `ERP_PUBLIC_URL`), `ERP_PUBLIC_URL` (base of returned file URLs), `GOOGLE_MAPS_API_KEY` (optional neighbourhood lookup), `ENFORCE_SUBSCRIPTION` (default `true`).
- Caches: subscription 60 s, client settings / module settings / branch tree 30 s, application statuses `CACHE_TTL_SETTINGS`, role permissions `CACHE_TTL_PERMISSIONS`, notification settings and plan usage 60 s. A permission change on the web can take up to the permissions TTL to be seen here.
- Transactions: `KnexUnitOfWork`; document numbers are consumed inside the save transaction, so a failed save does not burn a number.
- Unit tests for the pure domain pieces: `tests/clientsDomain.test.ts`.
- Postman: `docs/Clients.postman_collection.json` — folders Auth, Branches & settings, Clients, Status & stage, Contacts & notes, Itinerary, Visit workspace, Forgotten visits, Visit justifications, Notifications, Tracking. Log in first; `token`, `client_id`, `visit_id`, `note_id`, `row_id` and `notification_id` are saved automatically where possible.
