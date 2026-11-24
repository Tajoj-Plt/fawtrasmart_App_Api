# Manual for fawtrasmart Api doc - HR / Payroll (Node) :

-Api_url_based : `{base_url}/api/v1/`

-Headers_required : `Accept: application/json`

Every endpoint below is read-only except `POST hr/advances` and `POST hr/advances/{id}/withdraw`.
No endpoint in this module writes a journal entry: approving, disbursing, settling and the
administrative cancellation of an advance, and everything about deductions, salary agreements and
payroll runs other than reading them, stay in the web ERP.

Shared gates on every `hr/*` endpoint, in this order:
1. subscription (`402 NO_SUBSCRIPTION` / `SUBSCRIPTION_EXPIRED` / `SUBSCRIPTION_INACTIVE` / `SUBSCRIPTION_SYNC_LOCKED`)
2. application key `salaries` (`403 MODULE_DISABLED`)
3. plan feature of the section (`402 PLAN_FEATURE_UNAVAILABLE`)
4. role permission from `users.role_id` → `role_has_permissions` → `permissions.name` (`403 FORBIDDEN`).
   Detail endpoints additionally require that entity's `.show` permission, exactly as the web guards its
   `@show` actions (`loans.show`, `deductions.show`, `payslips.show`, `disbursements.show`).
5. employee scope — the DataScope ladder pivoting on `employee_id` (`403 OUT_OF_SCOPE` on a record outside it)

---

| process name | HR sections |
|---|---|
| API_End point | `GET hr/sections` |
| description | the payroll sections this role may open, with plan locks and the create flag |
| Auth_method | Bearer token |
| permission | any of loans.create / loans.index / deductions.index / payslips.index / disbursements.index |
| req_parameters | none |
| Status_Code | 200 - success , 401 - USER_NOT_FOUND |
| res_body | `data : { groups[ { key, title{ar,en}, items[ { key, title{ar,en}, icon, locked, canCreate } ] } ] }` |

Section keys, their gate permission and plan feature:

| key | gate permission | plan feature | create permission |
|---|---|---|---|
| `overview` | any of the others | – | – |
| `advanceRequests` | `loans.create` | `hr_advances` | `loans.create` |
| `advances` | `loans.index` | `hr_advances` | – |
| `deductions` | `deductions.index` | `hr_deductions` | – |
| `salarySlips` | `payslips.index` | `hr_payslips` | – |
| `payslips` | `disbursements.index` | `hr_payroll` | – |

---

| process name | HR overview |
|---|---|
| API_End point | `GET hr/overview` |
| description | the caller's employee card, own advance summary with scope counts, scope deduction figures, own latest monthly payslip — each block null when the role cannot see that section |
| Auth_method | Bearer token |
| permission | any of loans.create / loans.index / deductions.index / payslips.index / disbursements.index |
| req_parameters | none |
| Status_Code | 200 - success , 402 , 403 - FORBIDDEN / MODULE_DISABLED |
| res_body | `data : { employee{ id, name, jobTitle, department, hasAdvanceAccount } \| null, advances{ issued, settled, remaining, pending, active } \| null, deductions{ count, pending, unsettledTotal } \| null, payslip{ id, periodLabel, netSalary, stage, stageLabel } \| null }` |

---

| process name | List advances |
|---|---|
| API_End point | `GET hr/advances` |
| description | advance requests (`salary_advance_requests`) merged with the legacy advances (`salary_advances`) in the caller's employee scope; `mine=1` narrows it to the caller's own employee id and reads the request table only |
| Auth_method | Bearer token |
| permission | loans.index — or loans.create with `mine=1` |
| req_parameters | 1- page 2- perPage (max 100, default 20) 3- stage (pending \| approved \| disbursed \| repaying \| settled \| rejected \| cancelled) 4- search (employee name or amount) 5- from (YYYY-MM-DD) 6- to 7- mine (1/0) |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED , 422 - validation |
| res_body | `data : { items[ AdvanceRow ], total, page, perPage, totals{ amount, remaining }, stats{ pending, approved, disbursed, settled } }` |

`AdvanceRow = { id, source ('request'\|'legacy'), employee{ id, name } \| null, amount, advanceType ('normal'\|'scheduled'), installmentsCount, installmentAmount, startMonth, paidInstallments, remainingInstallments, status, stage, stageLabel, requestedDate, approvedDate, disbursedAt, isSettled, settledAmount, remainingAmount, reason, rejectionReason, treasury{ id, name } \| null, currency }`

Stage is derived, not stored: `rejected` / `cancelled` / `pending` from `status`; `approved` = approved with no `disbursed_at`; `settled` = `is_settled`; `repaying` = disbursed with something repaid; `disbursed` = disbursed with nothing repaid. Legacy rows carry their own mapping from their paid installments and only ever reach the stages `disbursed`, `repaying`, `settled`, `cancelled` — so a `stage` filter outside that set drops them.

---

| process name | Advance details |
|---|---|
| API_End point | `GET hr/advances/{id}` |
| description | one advance with its installments, approver trail, journals and whether the caller may withdraw it |
| Auth_method | Bearer token |
| permission | (loans.index or loans.create) **and** loans.show |
| req_parameters | 1- source (request \| legacy, default request) |
| Status_Code | 200 - success , 402 , 403 - FORBIDDEN / OUT_OF_SCOPE , 404 - ADVANCE_NOT_FOUND , 422 - validation |
| res_body | `data : { ...AdvanceRow, installments[ { id, number, amount, dueDate, paymentDate, status } ], approver{ id, name } \| null, approvedBy, disbursedBy, adminNotes, cancellationReason, journals[ { id, referenceNumber, date } ], can{ withdraw } }` |

`can.withdraw` is true only for the caller's own pending request while holding `loans.create`. A request's installments are read from the payroll-run items that deducted it (`payroll_run_items.source_table = 'salary_advance_requests'`); a legacy advance's installments come from `installment_payments`.

---

| process name | Advance request screen data |
|---|---|
| API_End point | `GET hr/advances/create-data` |
| description | whether the caller has an advance account, the approvers they may pick, their advance summary from the ledger, and the monthly plan quota |
| Auth_method | Bearer token |
| permission | loans.create |
| req_parameters | none |
| Status_Code | 200 - success , 402 , 403 - FORBIDDEN / MODULE_DISABLED , 422 - NO_EMPLOYEE |
| res_body | `data : { hasAdvanceAccount, approvers[ { id, name } ], summary{ issued, settled, remaining }, limit{ reached, used, max } \| null }` |

`approvers` are the users whose role holds `loans.approve`, minus the caller, narrowed to the departments configured in `payroll_settings.advance_approver_department_ids` when that JSON array is non-empty (an employee counts through `employees.department_id` or `department_employee`). `limit` is null when the plan does not meter `advance_requests`.

---

| process name | Request an advance |
|---|---|
| API_End point | `POST hr/advances` |
| description | the employee asks for an advance in their own name: a pending row, a `logs` entry and an internal notification to the approver. No journal entry. |
| Auth_method | Bearer token |
| permission | loans.create |
| req_parameters | 1- amount (required, numeric, min 1) 2- reason (required, max 500) 3- requestedDate (required, YYYY-MM-DD, today or later) 4- approverUserId (required, one of the approver list) |
| Status_Code | 201 - created , 402 - PLAN_FEATURE_UNAVAILABLE / PLAN_LIMIT_REACHED , 403 - FORBIDDEN / MODULE_DISABLED , 422 - NO_EMPLOYEE / NO_ADVANCE_ACCOUNT / validation |
| res_body | `message , data : { id }` |

Checks run in this order: a linked `users.employee_id` (`NO_EMPLOYEE`), `employees.employee_advance_account_id` pointing at an existing `accounts` row (`NO_ADVANCE_ACCOUNT`), the `advance_requests` monthly quota (`PLAN_LIMIT_REACHED`), then the field rules, and last the approver-list check. The notification description ends with ` - رقم الطلب #{id}` — the web's notification popup reads the request id out of it.

---

| process name | Withdraw an advance request |
|---|---|
| API_End point | `POST hr/advances/{id}/withdraw` |
| description | the requester pulls their own request back before it is decided: status `cancelled` with the reason «سحبه الموظف قبل البتّ فيه», and the approver's unread `advance_request` notification is marked read |
| Auth_method | Bearer token |
| permission | loans.create (own request only) |
| req_parameters | none |
| Status_Code | 200 - success , 402 , 403 - FORBIDDEN / OUT_OF_SCOPE , 404 - ADVANCE_NOT_FOUND , 422 - ADVANCE_NOT_PENDING |
| res_body | `message , data : { id, stage }` |

---

| process name | List deductions |
|---|---|
| API_End point | `GET hr/deductions` |
| description | employee deductions and penalties in the caller's employee scope, with the scope-wide statistics the web screen shows |
| Auth_method | Bearer token |
| permission | deductions.index |
| req_parameters | 1- page 2- perPage (max 100, default 20) 3- status (pending \| approved \| rejected \| settled \| partially_settled \| cancelled) 4- type (absence \| late \| early_leave \| half_day \| violation \| custody_damage \| admin_penalty \| other) 5- search (employee name, code, reason, id) 6- from 7- to |
| Status_Code | 200 - success , 402 , 403 - FORBIDDEN / MODULE_DISABLED , 422 - validation |
| res_body | `data : { items[ DeductionRow ], total, page, perPage, totals{ amount, remaining }, stats{ pending, approved, settled, cancelled, unsettledTotal } }` |

`DeductionRow = { id, code, employee{ id, name } \| null, deductionType, deductionTypeLabel, amount, settledAmount, remainingAmount, progressPercentage, status, statusLabel, date, reason, notes }`. `totals` follow the filters; `stats` are computed over the whole scope, as the web screen does.

---

| process name | Deduction details |
|---|---|
| API_End point | `GET hr/deductions/{id}` |
| description | one deduction with its decision timestamps, posted amount, journals (`DED-`, `DED-CAN-`, `DED-COL-`, `DED-WVR-`) and its audit trail |
| Auth_method | Bearer token |
| permission | deductions.index **and** deductions.show |
| req_parameters | none |
| Status_Code | 200 - success , 402 , 403 - FORBIDDEN / OUT_OF_SCOPE , 404 - DEDUCTION_NOT_FOUND |
| res_body | `data : { ...DeductionRow, approvedAt, rejectedAt, rejectionReason, cancelledAt, cancellationReason, settledAt, postedAmount, journals[ { id, referenceNumber, date } ], history[ { id, action, actionLabel, description, notes, amount, at, user{ id, name } \| null } ] }` |

---

| process name | List salary agreements |
|---|---|
| API_End point | `GET hr/salary-slips` |
| description | `salary_slips` — a continuing salary agreement per employee, NOT one month's pay. Its totals are summed from its `salary_items`. |
| Auth_method | Bearer token |
| permission | payslips.index |
| req_parameters | 1- page 2- perPage (max 100, default 20) 3- status (draft \| approved \| active \| stopped \| expired) 4- search (employee name or code, slip code, id) |
| Status_Code | 200 - success , 402 , 403 - FORBIDDEN / MODULE_DISABLED , 422 - validation |
| res_body | `data : { items[ SlipRow ], total, page, perPage }` |

`SlipRow = { id, code, employee{ id, name } \| null, basicAmount, currency, frequency, scheduledPaymentDay, startDate, endDate, status, statusLabel, totalAdditions, totalDeductions, netSalary }`, where `totalAdditions` sums `salary_items.amount` with `type = 1`, `totalDeductions` sums `type = 2`, and `netSalary = basicAmount + additions - deductions`.

---

| process name | Salary agreement details |
|---|---|
| API_End point | `GET hr/salary-slips/{id}` |
| description | one agreement with its components split by direction |
| Auth_method | Bearer token |
| permission | payslips.index **and** payslips.show |
| req_parameters | none |
| Status_Code | 200 - success , 402 , 403 - FORBIDDEN / OUT_OF_SCOPE , 404 - SLIP_NOT_FOUND |
| res_body | `data : { ...SlipRow, notes, approvedAt, stoppedAt, stopReason, additions[ { id, name, amount, isInsurable } ], deductions[ { id, name, amount, isInsurable } ] }` |

---

| process name | List monthly payslips |
|---|---|
| API_End point | `GET hr/payslips` |
| description | `payroll_runs` — one disbursement record per period, generated from a salary agreement |
| Auth_method | Bearer token |
| permission | disbursements.index |
| req_parameters | 1- page 2- perPage (max 100, default 20) 3- stage (awaiting_approval \| scheduled \| ready \| held \| paid \| cancelled) 4- search (employee name, run code, id) 5- from (period_from ≥) 6- to (period_to ≤) |
| Status_Code | 200 - success , 402 , 403 - FORBIDDEN / MODULE_DISABLED , 422 - validation |
| res_body | `data : { items[ RunRow ], total, page, perPage }` |

`RunRow = { id, employee{ id, name } \| null, periodFrom, periodTo, periodLabel, scheduledDate, basicAmount, totalAdditions, totalDeductions, totalAdvancesDeducted, netSalary, status, stage, stageLabel, disbursedAt }`. `status` holds only `pending` / `disbursed` / `cancelled`; the stage is derived from it plus `held_at`, `scheduled_date` and whether the agreement's payroll (`payrolls.status`) is approved — and `payroll_settings.require_disbursement_approval` (default on) decides whether `awaiting_approval` exists at all.

---

| process name | Monthly payslip details |
|---|---|
| API_End point | `GET hr/payslips/{id}` |
| description | one payslip with its items split into the five kinds |
| Auth_method | Bearer token |
| permission | disbursements.index **and** disbursements.show |
| req_parameters | none |
| Status_Code | 200 - success , 402 , 403 - FORBIDDEN / OUT_OF_SCOPE , 404 - PAYSLIP_NOT_FOUND |
| res_body | `data : { ...RunRow, notes, treasury{ id, name } \| null, salarySlipId, items{ additions[ Item ], deductions[ Item ], advances[ Item ], employer[ Item ], retro[ Item ] } }` |

`Item = { id, name, amount, description, sourceTable, sourceId }`. `employer` is the company's insurance share and does not reduce the net; `retro` are back-dated increases added on disbursement.

---

## Error codes

| code | status | meaning |
|---|---|---|
| `NO_EMPLOYEE` | 422 | the account has no `users.employee_id`, so it cannot request an advance |
| `NO_ADVANCE_ACCOUNT` | 422 | the employee has no advance account in the chart of accounts |
| `ADVANCE_NOT_PENDING` | 422 | the request has already been decided, so it cannot be withdrawn |
| `ADVANCE_NOT_FOUND` | 404 | no such advance |
| `DEDUCTION_NOT_FOUND` | 404 | no such deduction |
| `SLIP_NOT_FOUND` | 404 | no such salary agreement |
| `PAYSLIP_NOT_FOUND` | 404 | no such monthly payslip |
| `SECTION_FORBIDDEN` | 403 | the role cannot open that section (`hr/sections` evaluation) |
| `CREATE_FORBIDDEN` | 403 | the role may view the section but not add to it |
| `PLAN_LOCKED` | 403 | the section is outside the subscription plan |
| `PLAN_FEATURE_UNAVAILABLE` | 402 | the section's plan feature is not in the plan |
| `PLAN_LIMIT_REACHED` | 402 | the monthly `advance_requests` quota is used up |
| `MODULE_DISABLED` | 403 | the `salaries` application key is switched off |
| `FORBIDDEN` | 403 | the role lacks the endpoint's permission, or the request is not the caller's own |
| `OUT_OF_SCOPE` | 403 | the record belongs to an employee outside the caller's data scope |
| `VALIDATION_ERROR` | 422 | field rules; `details` maps the field to its Arabic messages |

## Employee scope

Every list and every single-record read is scoped on `employee_id`, exactly as
`ScopesToAccessibleEmployees::accessibleEmployeeIds()` resolves it (no header-branch narrowing):

| the role holds | it sees |
|---|---|
| `data_scope_all` | every employee |
| `data_scope_region` | the employees of its branch and the branches below it |
| `data_scope_branch` | the employees of its branch |
| `data_scope_department` | the employees of its department — or only itself when no department is stored |
| `data_scope_team` | itself and everyone under it through `employees.direct_manager_id` |
| nothing of the above | itself only |

An account with no employee row and no branch/all scope sees nobody. A record outside the scope is
`403 OUT_OF_SCOPE`, never a 404 — the row exists, the caller simply may not read it.
