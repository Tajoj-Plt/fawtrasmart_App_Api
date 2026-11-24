# Manual for fawtrasmart Api doc - Clients (Node) :

-Api_url_based : `{base_url}/api/v1/`

-Headers_required : `Accept: application/json`

---

| process name | Branches |
|---|---|
| API_End point | `GET branches` |
| description | branches the user can filter by |
| Auth_method | Bearer token |
| permission | none |
| req_parameters | 1- search (optional) |
| Status_Code | 200 - success , 422 - validation |
| res_body | `data : { currentBranchId, restricted, branches[ { id, name, code, parentId, nodeType, typeLabel, isMain, isCurrent } ] }` |

---

| process name | Client settings |
|---|---|
| API_End point | `GET clients/settings` |
| description | client module settings for the app |
| Auth_method | Bearer token |
| permission | none |
| req_parameters | none |
| Status_Code | 200 - success , 403 - MODULE_DISABLED |
| res_body | `data : { sections{ visits, itinerary, notes, routeTracking }, requiredFields{}, clientTypeScope, visit{ proximityMeters, competitorCapture, signatureRequired, noteDepositCount, notePhoto, noteMinPhotos, hideFinishedClients, allowReturnSameDay }, statusChangeRequiresApproval, itineraryMaxClientsPerDay, maxUploadKb, imageQuality, imageMaxDimension, siteTypes[], shift{ fullTimeValue, fullTimeLabel, hours[ { value, label } ], format } }` |

---

| process name | Client form options |
|---|---|
| API_End point | `GET clients/options` |
| description | lists for add / edit client form |
| Auth_method | Bearer token |
| permission | clients_add_client / clients_edit_data |
| req_parameters | 1- clientId (optional) |
| Status_Code | 200 - success , 403 - FORBIDDEN / CLIENT_FORBIDDEN , 404 - CLIENT_NOT_FOUND |
| res_body | `data : { branchTree[ { id, name, parentId, selectable, nodeType, typeLabel } ], categories[ { id, name } ], statuses[ { id, name, color } ], registrationStages[ { id, name } ], canAssignEmployees, employees[ { id, name, department } ], clientTypeScope, nextCode, requiredFields{ tradeName, phone, mobile, taxNumber, email, commercialRegistration, categoryId, registrationStageId, location, groupId, attachments }, maxUploadKb }` |

---

| process name | Clients map |
|---|---|
| API_End point | `GET clients/map` |
| description | clients with location (max 2000) |
| Auth_method | Bearer token |
| permission | clients_view_all_clients / clients_view_own_clients / clients_view_by_employee_groups / clients_view_by_daily_itinerary |
| req_parameters | same filters as list clients (page / perPage ignored) |
| Status_Code | 200 - success , 403 - FORBIDDEN / BRANCH_FORBIDDEN , 422 - validation |
| res_body | `data : { clients[ { id, code, tradeName, phone, mobile, status{ id, name, color }, branch{ id, name }, neighborhood, location{ latitude, longitude }, balance, balanceFormatted, balanceDirection, branchPath, needsVisit, openVisitId, itinerarySource{ tone, label } } ], total, itineraryOnly }` |

---

| process name | List clients |
|---|---|
| API_End point | `GET clients` |
| description | clients list |
| Auth_method | Bearer token |
| permission | clients_view_all_clients / clients_view_own_clients / clients_view_by_employee_groups / clients_view_by_daily_itinerary |
| req_parameters | 1- search (optional) 2- branchId (optional) 3- includeDescendants (1 / 0, optional) 4- status (id / no_status, optional) 5- registrationStage (optional) 6- categoryId (optional) 7- type (1 / 2, optional) 8- region (optional) 9- neighborhood (optional) 10- client (optional) 11- name (optional) 12- dateFrom (optional) 13- dateTo (optional) 14- employee (optional) 15- overCreditLimit (optional) 16- customerTargetId (id / no_target, optional) 17- lastInvoicePeriod (optional) 18- lastPaymentPeriod (optional) 19- lastActivityPeriod (optional) 20- sort (newest / name, optional) 21- latitude + longitude (optional) 22- perPage (1-100, optional) 23- page (optional) |
| Status_Code | 200 - success , 403 - FORBIDDEN / BRANCH_FORBIDDEN , 422 - validation |
| res_body | `data : { items[ { id, code, tradeName, phone, mobile, status{ id, name, color }, branch{ id, name }, neighborhood, location{ latitude, longitude }, balance, balanceFormatted, balanceDirection, needsVisit, openVisitId, distanceKm } ], total, page, perPage, lastPage }` |

---

| process name | Add client |
|---|---|
| API_End point | `POST clients` |
| description | add client (multipart/form-data) |
| Auth_method | Bearer token |
| permission | clients_add_client |
| req_parameters | 1- clientTreeBranchId 2- tradeName 3- firstName 4- lastName 5- phone 6- mobile 7- email 8- categoryId 9- registrationStageId 10- clientType 11- taxNumber 12- commercialRegistration 13- currency 14- printingMethod 15- street1 16- street2 17- city 18- region 19- postalCode 20- country 21- notes 22- latitude 23- longitude 24- neighborhoodNameManual 25- attachments (image) 26- employeeClientIds[] 27- contacts[i][firstName / lastName / email / phone / mobile] — required fields from settings |
| Status_Code | 201 - created , 403 - FORBIDDEN , 422 - validation , 500 - SAVE_FAILED |
| res_body | `{ success, message, data : { id, code, tradeName, phone, mobile, status{}, branch{}, neighborhood, location{}, balance, balanceFormatted, balanceDirection, visitId } }` |

---

| process name | Client details |
|---|---|
| API_End point | `GET clients/{id}` |
| description | client details |
| Auth_method | Bearer token |
| permission | clients_view_all_clients / clients_view_own_clients / clients_view_by_employee_groups / clients_view_by_daily_itinerary |
| req_parameters | none |
| Status_Code | 200 - success , 403 - CLIENT_FORBIDDEN / MUST_VISIT_FIRST / VISIT_FINISHED_TODAY , 404 - CLIENT_NOT_FOUND |
| res_body | `data : { id, code, tradeName, displayName, firstName, lastName, phone, mobile, email, status{}, branch{}, branchPath, treeNodeId, category{ id, name }, registrationStage{ id, name }, location{}, neighborhood, balance, balanceFormatted, balanceDirection, creditLimit, itemQuantityLimit, clientType, taxNumber, commercialRegistration, currency, printingMethod, notes, street1, street2, city, region, postalCode, country, attachmentUrl, assignedEmployees[ { id, name } ], contacts[ { id, firstName, lastName, email, phone, mobile } ], createdAt, can{ edit, changeStatus, addNote, viewNotes, openVisit } }` |

---

| process name | Update client |
|---|---|
| API_End point | `POST clients/{id}` |
| description | update client (multipart/form-data) |
| Auth_method | Bearer token |
| permission | clients_edit_data |
| req_parameters | same as add client + itemQuantityLimit + contacts[i][id] (attachments optional) |
| Status_Code | 200 - success , 403 - FORBIDDEN / CLIENT_FORBIDDEN , 404 - CLIENT_NOT_FOUND , 422 - validation , 500 - SAVE_FAILED |
| res_body | `{ success, message, data : { client summary } }` |

---

| process name | Status options |
|---|---|
| API_End point | `GET clients/{id}/status-options` |
| description | status and stage lists with approvers |
| Auth_method | Bearer token |
| permission | clients_change_status |
| req_parameters | none |
| Status_Code | 200 - success , 403 - FORBIDDEN / CLIENT_FORBIDDEN , 404 - CLIENT_NOT_FOUND |
| res_body | `data : { currentStatusId, currentStageId, statuses[ { id, name, color } ], stages[ { id, name, color } ], statusNeedsApproval, stageNeedsApproval, statusApprovers[ { id, name } ], stageApprovers[ { id, name } ] }` |

---

| process name | Change status |
|---|---|
| API_End point | `POST clients/{id}/status` |
| description | change status or send approval request |
| Auth_method | Bearer token |
| permission | clients_change_status |
| req_parameters | 1- statusId 2- managerId (required when approval needed) 3- notes (optional) 4- visitId (optional) |
| Status_Code | 200 - success , 402 - PLAN_LIMIT_REACHED , 403 - FORBIDDEN / CLIENT_FORBIDDEN , 404 - CLIENT_NOT_FOUND , 422 - validation / NO_CHANGE |
| res_body | `{ success, message, data : { clientId, statusId, pendingApproval } }` |

---

| process name | Change stage |
|---|---|
| API_End point | `POST clients/{id}/stage` |
| description | change stage or send approval request |
| Auth_method | Bearer token |
| permission | clients_change_status |
| req_parameters | 1- stageId (empty = no stage) 2- managerId (required when approval needed) 3- notes (optional) 4- visitId (optional) |
| Status_Code | 200 - success , 402 - PLAN_LIMIT_REACHED , 403 - FORBIDDEN / CLIENT_FORBIDDEN , 404 - CLIENT_NOT_FOUND , 422 - validation / NO_CHANGE |
| res_body | `{ success, message, data : { clientId, stageId, pendingApproval } }` |

---

| process name | Client contacts |
|---|---|
| API_End point | `GET clients/{id}/contacts` |
| description | client staff contacts with shift |
| Auth_method | Bearer token |
| permission | client_follow_up_view_notes_attachments_appointments_all / client_follow_up_view_notes_attachments_appointments_assigned / client_follow_up_view_notes_attachments_appointments_own |
| req_parameters | none |
| Status_Code | 200 - success , 403 - FORBIDDEN / CLIENT_FORBIDDEN , 404 - CLIENT_NOT_FOUND |
| res_body | `data : [ { id, employeeName, employeePosition, employeePhone, isPrimary, shift, shiftStart, shiftEnd, shiftLabel, imageUrl, invoiceId, invoiceCode, createdBy, createdAt } ]` |

---

| process name | Add contact |
|---|---|
| API_End point | `POST clients/{id}/contacts` |
| description | add client staff contact (multipart/form-data) |
| Auth_method | Bearer token |
| permission | client_follow_up_add_notes_attachments_appointments_all / client_follow_up_add_notes_attachments_appointments_assigned / client_follow_up_add_notes_attachments_appointments_own / clients_add_employee_note |
| req_parameters | 1- employeeName 2- employeePhone 3- shift (full / HH:00\|HH:00) 4- employeePosition (optional) 5- isPrimary (optional) 6- invoiceId (optional) 7- image (optional) |
| Status_Code | 201 - created , 403 - FORBIDDEN / CLIENT_FORBIDDEN , 404 - CLIENT_NOT_FOUND , 422 - validation |
| res_body | `{ success, message, data : { contact } }` |

---

| process name | Client notes |
|---|---|
| API_End point | `GET clients/{id}/notes` |
| description | client notes (paginated) |
| Auth_method | Bearer token |
| permission | client_follow_up_view_notes_attachments_appointments_all / client_follow_up_view_notes_attachments_appointments_assigned / client_follow_up_view_notes_attachments_appointments_own |
| req_parameters | 1- page (optional) 2- perPage (1-100, optional) |
| Status_Code | 200 - success , 403 - FORBIDDEN / CLIENT_FORBIDDEN , 404 - CLIENT_NOT_FOUND , 422 - validation |
| res_body | `data : { items[ { id, clientId, description, process, status, depositCount, competitorDocuments, siteType, shiftStart, shiftEnd, contact{ id, name }, employee{ id, name }, attachments[ { index, url } ], competitors[ { competitorId, name, assetCount, photoUrl } ], canEdit, createdAt } ], total, page, perPage, lastPage }` |

---

| process name | Add note |
|---|---|
| API_End point | `POST clients/{id}/notes` |
| description | add client note (multipart/form-data) |
| Auth_method | Bearer token |
| permission | client_follow_up_add_notes_attachments_appointments_all / client_follow_up_add_notes_attachments_appointments_assigned / client_follow_up_add_notes_attachments_appointments_own / clients_add_employee_note |
| req_parameters | 1- clientEmployeeId 2- description 3- depositCount (required by setting) 4- attachments[] (min photos by setting, max 10) 5- currentLatitude 6- currentLongitude (required unless exempt) 7- shift (optional) 8- process (optional) 9- siteType (optional) |
| Status_Code | 201 - created , 402 - PLAN_LIMIT_REACHED , 403 - FORBIDDEN / CLIENT_FORBIDDEN , 404 - CLIENT_NOT_FOUND , 422 - validation / out of range |
| res_body | `{ success, message, data : { note } }` |

---

| process name | Update note |
|---|---|
| API_End point | `POST notes/{id}` |
| description | update note (multipart/form-data) |
| Auth_method | Bearer token |
| permission | client_follow_up_edit_delete_notes_attachments_appointments_all / client_follow_up_edit_delete_notes_attachments_appointments_assigned / client_follow_up_edit_delete_notes_attachments_appointments_own |
| req_parameters | 1- clientEmployeeId 2- description 3- depositCount 4- siteType 5- competitorDocuments 6- shift 7- attachments[] (optional, appended) |
| Status_Code | 200 - success , 403 - FORBIDDEN / NOTE_FORBIDDEN / CLIENT_FORBIDDEN , 404 - NOTE_NOT_FOUND , 422 - validation |
| res_body | `{ success, message, data : { note } }` |

---

| process name | Delete note |
|---|---|
| API_End point | `DELETE notes/{id}` |
| description | delete note |
| Auth_method | Bearer token |
| permission | client_follow_up_edit_delete_notes_attachments_appointments_all / client_follow_up_edit_delete_notes_attachments_appointments_assigned / client_follow_up_edit_delete_notes_attachments_appointments_own |
| req_parameters | none |
| Status_Code | 200 - success , 403 - FORBIDDEN / NOTE_FORBIDDEN / CLIENT_FORBIDDEN , 404 - NOTE_NOT_FOUND |
| res_body | `{ success, message, data : null }` |

---

| process name | Delete note attachment |
|---|---|
| API_End point | `DELETE notes/{id}/attachments/{index}` |
| description | delete one note photo |
| Auth_method | Bearer token |
| permission | client_follow_up_edit_delete_notes_attachments_appointments_all / client_follow_up_edit_delete_notes_attachments_appointments_assigned / client_follow_up_edit_delete_notes_attachments_appointments_own |
| req_parameters | none |
| Status_Code | 200 - success , 403 - FORBIDDEN / NOTE_FORBIDDEN / CLIENT_FORBIDDEN , 404 - NOTE_NOT_FOUND / ATTACHMENT_NOT_FOUND |
| res_body | `{ success, message, data : { remaining } }` |

---

| process name | Itinerary day |
|---|---|
| API_End point | `GET itinerary/day` |
| description | one day of a rep itinerary |
| Auth_method | Bearer token |
| permission | clients_daily_itinerary_view / clients_daily_itinerary_add_for_others |
| req_parameters | 1- date (YYYY-MM-DD, optional) 2- employeeId (user id, optional) |
| Status_Code | 200 - success , 403 - FORBIDDEN / SECTION_DISABLED / ITINERARY_FORBIDDEN , 422 - validation |
| res_body | `data : { date, dateLabel, isToday, isPast, stops[ { id, clientId, name, code, clientStatus{ name, color }, place, address, phone, lat, lng, state, start, end, legKm, legMinutes, addedBy{ id, name, role, self }, note{ text, date }, photos[] } ], stats{ done, total, percent, km, minutes }, employee{ id, name }, isSelf, can{ add, postpone, start } }` |

---

| process name | Itinerary employees |
|---|---|
| API_End point | `GET itinerary/employees` |
| description | reps whose itinerary the user can open |
| Auth_method | Bearer token |
| permission | clients_daily_itinerary_view / clients_daily_itinerary_add_for_others |
| req_parameters | none |
| Status_Code | 200 - success , 403 - FORBIDDEN / SECTION_DISABLED |
| res_body | `data : [ { id, name } ]` |

---

| process name | Itinerary client picker |
|---|---|
| API_End point | `GET itinerary/clients` |
| description | clients to add to itinerary |
| Auth_method | Bearer token |
| permission | clients_daily_itinerary_add_client / clients_daily_itinerary_add_for_others |
| req_parameters | 1- employeeId (optional) 2- date (optional) 3- nodeId (optional) 4- q (optional) |
| Status_Code | 200 - success , 403 - FORBIDDEN / SECTION_DISABLED / ITINERARY_FORBIDDEN , 422 - validation |
| res_body | `data : { clients[ { id, name, code, place, inRoute } ], total, limit, nodes[ { id, label, type } ] }` |

---

| process name | Add to itinerary |
|---|---|
| API_End point | `POST itinerary/clients` |
| description | add clients to a day |
| Auth_method | Bearer token |
| permission | clients_daily_itinerary_add_client / clients_daily_itinerary_add_for_others |
| req_parameters | 1- clientIds[] (1-100) 2- employeeId (optional) 3- date (optional, today or later) |
| Status_Code | 200 - success , 403 - FORBIDDEN / SECTION_DISABLED / ITINERARY_FORBIDDEN , 422 - validation / TARGET_NOT_ALLOWED / DAY_LOCKED / NOTHING_ADDED , 500 - SAVE_FAILED |
| res_body | `{ success, message, data : { added, already, outOfScope, unassigned, full, locked } }` |

---

| process name | Postpone visit |
|---|---|
| API_End point | `POST itinerary/{rowId}/postpone` |
| description | move planned visit to end of tomorrow |
| Auth_method | Bearer token |
| permission | clients_itinerary_edit |
| req_parameters | none |
| Status_Code | 200 - success , 403 - FORBIDDEN / SECTION_DISABLED / ITINERARY_FORBIDDEN , 404 - ROW_NOT_FOUND , 422 - NOT_POSTPONABLE / DAY_FULL / ALREADY_TOMORROW |
| res_body | `{ success, message, data : { id, visitDate } }` |

---

| process name | Return client to itinerary |
|---|---|
| API_End point | `POST clients/{id}/return-to-itinerary` |
| description | return finished client to today |
| Auth_method | Bearer token |
| permission | clients_visits_track / clients_itinerary_add / clients_visit_workspace_access / clients_must_visit_before_view |
| req_parameters | none |
| Status_Code | 200 - success , 403 - FORBIDDEN / RETURN_DISABLED , 404 - CLIENT_NOT_FOUND , 422 - NOT_FINISHED_TODAY |
| res_body | `{ success, message, data : { clientId } }` |

---

| process name | Forgotten visits |
|---|---|
| API_End point | `GET visits/forgotten` |
| description | open visits left unfinished |
| Auth_method | Bearer token |
| permission | clients_view_forgotten_visits_own / clients_view_forgotten_visits_all |
| req_parameters | 1- scope (own / all, optional) |
| Status_Code | 200 - success , 403 - FORBIDDEN , 422 - validation |
| res_body | `data : { scope, count, visits[ { id, visitNumber, visitDate, startedAt, stage, employee{ id, name }, client{ id, tradeName, code }, isOwn } ] }` |

---

| process name | Close forgotten visit |
|---|---|
| API_End point | `POST visits/forgotten/{id}/close` |
| description | close forgotten visit |
| Auth_method | Bearer token |
| permission | clients_close_forgotten_visits_own / clients_force_close_forgotten_visits |
| req_parameters | 1- notes (optional) |
| Status_Code | 200 - success , 402 - PLAN_LIMIT_REACHED , 403 - FORBIDDEN , 404 - VISIT_NOT_FOUND , 422 - validation |
| res_body | `{ success, message, data : { visitId } }` |

---

| process name | Cancel forgotten visit |
|---|---|
| API_End point | `POST visits/forgotten/{id}/cancel` |
| description | cancel forgotten visit |
| Auth_method | Bearer token |
| permission | clients_cancel_forgotten_visits |
| req_parameters | 1- cancelReason |
| Status_Code | 200 - success , 403 - FORBIDDEN , 404 - VISIT_NOT_FOUND , 422 - validation |
| res_body | `{ success, message, data : { visitId } }` |

---

| process name | Open visit |
|---|---|
| API_End point | `POST clients/{id}/visits/open` |
| description | open today visit or return the open one |
| Auth_method | Bearer token |
| permission | clients_visits_track / clients_itinerary_add / clients_visit_workspace_access / clients_must_visit_before_view |
| req_parameters | none |
| Status_Code | 201 - created , 200 - existing , 403 - FORBIDDEN / CLIENT_FORBIDDEN , 404 - CLIENT_NOT_FOUND |
| res_body | `{ success, message (created only), data : { visit } }` — same as visit details |

---

| process name | Visit details |
|---|---|
| API_End point | `GET visits/{id}` |
| description | visit workspace |
| Auth_method | Bearer token |
| permission | clients_visits_track / clients_itinerary_add / clients_visit_workspace_access / clients_must_visit_before_view |
| req_parameters | none |
| Status_Code | 200 - success , 403 - FORBIDDEN / VISIT_FORBIDDEN , 404 - VISIT_NOT_FOUND |
| res_body | `data : { visitId, stage, startedAt, paused, elapsedSeconds, visitNumber, visitDate, departureTime, outcome, cancelReason, employee{ id, name }, client{}, clientLocation{ latitude, longitude }, steps{ hasContact, hasShift, hasNote, competitorStep, hasCompetitors, docsUnlocked, hasSale, canComplete, canReturn, outcome }, rules{ proximityMeters, anyLocation, competitorCapture, signatureRequired, noteDepositCount, notePhoto, noteMinPhotos, maxUploadKb }, can{ complete, cancel, changeShift, replyNotifications, changeStatus, statusNeedsApproval, stageNeedsApproval }, statusApprovers[], stageApprovers[], contacts[], notes[], competitorsObserved[ { competitorId, name, assetCount, photoUrl } ], competitorOptions[ { id, name } ], clientNotifications[ { id, title, description, read, from, createdAt, replies[ { description, createdAt } ] } ], visitDocuments[ { group, type, id, number, amount, at } ], clientDocuments{ invoices[], returns[], receipts[], expenses[], credit_notes[], exchanges[] } }` |

---

| process name | Start visit |
|---|---|
| API_End point | `POST visits/{id}/start` |
| description | start visit from client location |
| Auth_method | Bearer token |
| permission | clients_visits_track / clients_itinerary_add / clients_visit_workspace_access / clients_must_visit_before_view |
| req_parameters | 1- currentLatitude 2- currentLongitude |
| Status_Code | 200 - success / already started , 402 - PLAN_LIMIT_REACHED , 403 - FORBIDDEN / VISIT_FORBIDDEN , 404 - VISIT_NOT_FOUND , 422 - validation / OUT_OF_RANGE / VISIT_CLOSED |
| res_body | `{ success, message, data : { visitId, stage, startedAt, paused, elapsedSeconds } }` |

---

| process name | Pause / resume visit |
|---|---|
| API_End point | `POST visits/{id}/toggle-pause` |
| description | pause or resume visit timer |
| Auth_method | Bearer token |
| permission | clients_visits_track / clients_itinerary_add / clients_visit_workspace_access / clients_must_visit_before_view |
| req_parameters | none |
| Status_Code | 200 - success , 403 - FORBIDDEN / VISIT_FORBIDDEN , 404 - VISIT_NOT_FOUND , 422 - VISIT_NOT_STARTED / VISIT_CLOSED |
| res_body | `{ success, message, data : { visitId, stage, startedAt, paused, elapsedSeconds } }` |

---

| process name | Visit contact |
|---|---|
| API_End point | `POST visits/{id}/contact` |
| description | step 1 — add client contact (multipart/form-data) |
| Auth_method | Bearer token |
| permission | workspace (clients_visits_track / clients_itinerary_add / clients_visit_workspace_access / clients_must_visit_before_view) + add notes (client_follow_up_add_notes_attachments_appointments_all / client_follow_up_add_notes_attachments_appointments_assigned / client_follow_up_add_notes_attachments_appointments_own / clients_add_employee_note) |
| req_parameters | 1- employeeName 2- employeePhone 3- shift 4- employeePosition (optional) 5- isPrimary (optional) 6- invoiceId (optional) 7- image (optional) |
| Status_Code | 201 - created , 403 - FORBIDDEN / VISIT_FORBIDDEN , 404 - VISIT_NOT_FOUND , 422 - validation / VISIT_NOT_STARTED / VISIT_CLOSED |
| res_body | `{ success, message, data : { contact fields, steps{} } }` |

---

| process name | Contact shift |
|---|---|
| API_End point | `POST visits/{id}/contact-shift` |
| description | step 2 — set contact shift |
| Auth_method | Bearer token |
| permission | clients_visits_track / clients_itinerary_add / clients_visit_workspace_access / clients_must_visit_before_view (change after set: clients_change_contact_shift) |
| req_parameters | 1- clientEmployeeId 2- shift (full / HH:00\|HH:00) |
| Status_Code | 200 - success , 403 - FORBIDDEN / VISIT_FORBIDDEN / SHIFT_LOCKED , 404 - VISIT_NOT_FOUND , 422 - validation / VISIT_NOT_STARTED / VISIT_CLOSED |
| res_body | `{ success, message, data : { contact fields, steps{} } }` |

---

| process name | Visit note |
|---|---|
| API_End point | `POST visits/{id}/notes` |
| description | step 3 — visit note (multipart/form-data) |
| Auth_method | Bearer token |
| permission | workspace (clients_visits_track / clients_itinerary_add / clients_visit_workspace_access / clients_must_visit_before_view) + add notes (client_follow_up_add_notes_attachments_appointments_all / client_follow_up_add_notes_attachments_appointments_assigned / client_follow_up_add_notes_attachments_appointments_own / clients_add_employee_note) — shift change after set: clients_change_contact_shift |
| req_parameters | 1- clientEmployeeId 2- description 3- depositCount (required by setting) 4- attachments[] (min photos by setting, max 10) 5- currentLatitude 6- currentLongitude (required unless exempt) 7- shift (required if contact has none) 8- process (optional) 9- siteType (optional) |
| Status_Code | 201 - created , 402 - PLAN_LIMIT_REACHED , 403 - FORBIDDEN / VISIT_FORBIDDEN / SHIFT_LOCKED , 404 - VISIT_NOT_FOUND , 422 - validation / out of range / VISIT_NOT_STARTED / VISIT_CLOSED |
| res_body | `{ success, message, data : { noteId, steps{} } }` |

---

| process name | Competitors |
|---|---|
| API_End point | `POST visits/{id}/competitors` |
| description | step 4 — competitor capture (multipart/form-data) |
| Auth_method | Bearer token |
| permission | workspace (clients_visits_track / clients_itinerary_add / clients_visit_workspace_access / clients_must_visit_before_view) + add notes (client_follow_up_add_notes_attachments_appointments_all / client_follow_up_add_notes_attachments_appointments_assigned / client_follow_up_add_notes_attachments_appointments_own / clients_add_employee_note) |
| req_parameters | 1- competitors[i][competitorId] 2- competitors[i][assetCount] 3- competitors[i][photo] (max 30 rows) — or 1- noCompetitors=1 2- noCompetitorsPhoto |
| Status_Code | 200 - success , 403 - FORBIDDEN / VISIT_FORBIDDEN , 404 - VISIT_NOT_FOUND , 422 - validation / STEP_DISABLED / NOTE_REQUIRED / VISIT_NOT_STARTED / VISIT_CLOSED |
| res_body | `{ success, message, data : { saved, steps{} } }` |

---

| process name | Quick competitor |
|---|---|
| API_End point | `POST visits/{id}/competitors/quick` |
| description | add new competitor to list |
| Auth_method | Bearer token |
| permission | workspace (clients_visits_track / clients_itinerary_add / clients_visit_workspace_access / clients_must_visit_before_view) + add notes (client_follow_up_add_notes_attachments_appointments_all / client_follow_up_add_notes_attachments_appointments_assigned / client_follow_up_add_notes_attachments_appointments_own / clients_add_employee_note) |
| req_parameters | 1- name |
| Status_Code | 201 - created , 200 - existing , 403 - FORBIDDEN / VISIT_FORBIDDEN , 404 - VISIT_NOT_FOUND , 422 - validation / COMPETITOR_DISABLED / VISIT_NOT_STARTED / VISIT_CLOSED |
| res_body | `{ success, message, data : { id, name, existed } }` |

---

| process name | Read client notification |
|---|---|
| API_End point | `POST visits/{id}/notifications/{notificationId}/read` |
| description | mark client notification read |
| Auth_method | Bearer token |
| permission | clients_visits_track / clients_itinerary_add / clients_visit_workspace_access / clients_must_visit_before_view |
| req_parameters | none |
| Status_Code | 200 - success , 403 - FORBIDDEN / VISIT_FORBIDDEN , 404 - VISIT_NOT_FOUND / NOTIFICATION_NOT_FOUND |
| res_body | `{ success, message, data : { id, read } }` |

---

| process name | Reply client notification |
|---|---|
| API_End point | `POST visits/{id}/notifications/{notificationId}/reply` |
| description | reply to client notification |
| Auth_method | Bearer token |
| permission | workspace (clients_visits_track / clients_itinerary_add / clients_visit_workspace_access / clients_must_visit_before_view) + notifications_reply_to_notifications |
| req_parameters | 1- replyMessage |
| Status_Code | 200 - success , 402 - PLAN_LIMIT_REACHED , 403 - FORBIDDEN / VISIT_FORBIDDEN , 404 - VISIT_NOT_FOUND / NOTIFICATION_NOT_FOUND , 422 - validation |
| res_body | `{ success, message, data : { id } }` |

---

| process name | Complete visit |
|---|---|
| API_End point | `POST visits/{id}/complete` |
| description | finish visit (JSON or multipart) |
| Auth_method | Bearer token |
| permission | workspace (clients_visits_track / clients_itinerary_add / clients_visit_workspace_access / clients_must_visit_before_view) + clients_visit_complete |
| req_parameters | 1- currentLatitude 2- currentLongitude (required unless exempt) 3- clientSignature 4- employeeSignature (data:image base64, required by setting) 5- outcomeNotes (optional) 6- returnLater (optional) 7- returnTime (HH:MM, required with returnLater) |
| Status_Code | 200 - success , 402 - PLAN_LIMIT_REACHED , 403 - FORBIDDEN / VISIT_FORBIDDEN , 404 - VISIT_NOT_FOUND , 422 - validation / STEPS_INCOMPLETE / OUT_OF_RANGE / BAD_SIGNATURE / VISIT_NOT_STARTED / VISIT_CLOSED |
| res_body | `{ success, message, data : { visitId, outcome, durationMinutes, returnLater } }` |

---

| process name | Cancel visit |
|---|---|
| API_End point | `POST visits/{id}/cancel` |
| description | cancel visit with reason |
| Auth_method | Bearer token |
| permission | workspace (clients_visits_track / clients_itinerary_add / clients_visit_workspace_access / clients_must_visit_before_view) + clients_visit_cancel |
| req_parameters | 1- cancelReason 2- currentLatitude 3- currentLongitude (required unless exempt) |
| Status_Code | 200 - success , 403 - FORBIDDEN / VISIT_FORBIDDEN , 404 - VISIT_NOT_FOUND , 422 - validation / OUT_OF_RANGE / VISIT_CLOSED |
| res_body | `{ success, message, data : { visitId } }` |

---

| process name | Pending justifications |
|---|---|
| API_End point | `GET visit-justifications/pending` |
| description | visits waiting for my justification |
| Auth_method | Bearer token |
| permission | none |
| req_parameters | none |
| Status_Code | 200 - success , 403 - MODULE_DISABLED |
| res_body | `data : { exempt, pendingCount, awaitingApproval, visits[ { id, visitDate, dayOfWeek, client{ id, tradeName, code } } ] }` |

---

| process name | Submit justifications |
|---|---|
| API_End point | `POST visit-justifications` |
| description | justify missed visits |
| Auth_method | Bearer token |
| permission | none |
| req_parameters | 1- justifications{ "rowId": "text 5-250 chars" } (max 200) |
| Status_Code | 200 - success , 403 - MODULE_DISABLED , 422 - validation / EXEMPT / NOTHING_ACCEPTED |
| res_body | `{ success, message, data : { submitted[], rejected[] } }` |

---

| process name | My justifications |
|---|---|
| API_End point | `GET visit-justifications` |
| description | submitted justifications and exemption periods |
| Auth_method | Bearer token |
| permission | clients_visit_justifications_view_own / clients_visit_justifications_view_all |
| req_parameters | 1- page (optional) 2- perPage (1-100, optional) |
| Status_Code | 200 - success , 403 - FORBIDDEN , 422 - validation |
| res_body | `data : { items[ { id, visitDate, client{ id, tradeName, code }, justification, justificationDate, status, approvedBy } ], total, page, perPage, lastPage, periods[ { id, client, dateFrom, dateTo, status, reason } ] }` |

---

| process name | Justification details |
|---|---|
| API_End point | `GET visit-justifications/{id}` |
| description | one justification |
| Auth_method | Bearer token |
| permission | clients_visit_justifications_view_own / clients_visit_justifications_view_all |
| req_parameters | none |
| Status_Code | 200 - success , 403 - FORBIDDEN , 404 - JUSTIFICATION_NOT_FOUND |
| res_body | `data : { id, visitDate, client{ id, tradeName, code }, justification, justificationDate, status, approvedBy }` |

---

| process name | Update justification |
|---|---|
| API_End point | `PUT visit-justifications/{id}` |
| description | edit pending / rejected justification |
| Auth_method | Bearer token |
| permission | clients_visit_justifications_view_own / clients_visit_justifications_view_all |
| req_parameters | 1- justification (5-250 chars) |
| Status_Code | 200 - success , 403 - FORBIDDEN , 404 - JUSTIFICATION_NOT_FOUND , 422 - validation / EXEMPT / NO_JUSTIFICATION / ALREADY_APPROVED |
| res_body | `{ success, message, data : { id, visitDate, client{}, justification, justificationDate, status, approvedBy } }` |

---

| process name | Notification details |
|---|---|
| API_End point | `GET notifications/{id}` |
| description | notification with replies and decision |
| Auth_method | Bearer token |
| permission | sales.notifications.view |
| req_parameters | none |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN , 404 - NOTIFICATION_NOT_FOUND |
| res_body | `data : { id, title, description, type, read, isSender, isReceiver, from{ id, name }, to{ id, name }, client{ id, tradeName }, scheduledAt, createdAt, replies[ { id, description, from, createdAt } ], decision{ text, byId, byName, at } }` |

---

| process name | Reply notification |
|---|---|
| API_End point | `POST notifications/{id}/reply` |
| description | reply to the other party |
| Auth_method | Bearer token |
| permission | sales.notifications.reply + notifications_reply_to_notifications / data_scope_all |
| req_parameters | 1- replyMessage |
| Status_Code | 201 - created , 402 - PLAN_FEATURE_UNAVAILABLE / PLAN_LIMIT_REACHED , 403 - FORBIDDEN / REPLY_FORBIDDEN , 422 - validation / NO_COUNTERPART |
| res_body | `{ success, message, data : { id, replyTo } }` |

---

| process name | Send location |
|---|---|
| API_End point | `POST tracking/location` |
| description | send current location or batch |
| Auth_method | Bearer token |
| permission | clients_itinerary_edit |
| req_parameters | 1- latitude 2- longitude — or 1- points[ { latitude, longitude, recordedAt } ] (max 100) |
| Status_Code | 200 - success , 403 - FORBIDDEN / TRACKING_DISABLED , 422 - validation / NO_VALID_POINTS , 429 - RATE_LIMITED , 500 - SAVE_FAILED |
| res_body | `data : { received, saved, skipped, rejected }` |

---

| process name | Path |
|---|---|
| API_End point | `GET tracking/path` |
| description | day path and current location |
| Auth_method | Bearer token |
| permission | clients_itinerary_view / clients_view_by_daily_itinerary |
| req_parameters | 1- date (optional) 2- employeeId (optional) |
| Status_Code | 200 - success , 403 - FORBIDDEN / TRACKING_DISABLED / TRACKING_FORBIDDEN , 422 - validation |
| res_body | `data : { employee{ id, name }, date, current{ latitude, longitude, isLive, updatedAt }, distanceKm, pointsCount, points[ { latitude, longitude, at } ] }` |

---

| process name | Team locations |
|---|---|
| API_End point | `GET tracking/team` |
| description | latest location of team |
| Auth_method | Bearer token |
| permission | clients_itinerary_view / clients_view_by_daily_itinerary |
| req_parameters | none |
| Status_Code | 200 - success , 403 - FORBIDDEN / TRACKING_DISABLED |
| res_body | `data : { count, employees[ { employee{ id, name }, latitude, longitude, isLive, updatedAt, isMe } ] }` |
