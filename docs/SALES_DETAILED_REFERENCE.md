# FawtraSmart Mobile Backend (Node) — Sales — Detailed Reference

The sales part of the FawtraSmart mobile API served by the Node.js/Express backend in `MobileAppBackend/`: invoices, collections (single and bulk), returns, credit notes, product exchanges, quotes and sales orders (with conversion to invoice), daily closing, the rep's own targets and commissions, and the payments-by-employee report. It runs against the **same MySQL database as the ERP** and writes the rows the web writes — `invoices`, `invoice_items`, `taxs_invoice`, `payments_process`, `warehouse_permits(_products)`, `product_details`, `journal_entries`, `journal_entry_details`, `journal_entry_invoices`, `accounts`, `credit_notifications`, `product_exchanges(_items)`, `quotes`, `daily_closings(_stock_details)`, `client_relations`, `client_wallet_transactions`, `logs`, `event_logs`, `notifications`.

| | |
|---|---|
| **Base URL** | `{{base_url}}/api/v1/` (default local `http://localhost:4000`) |
| **Format** | JSON in / JSON out. `POST sales/exchanges` is `multipart/form-data` (photo required) |
| **Auth** | `Authorization: Bearer {accessToken}` from `POST /api/v1/auth/login` |
| **Field names** | camelCase in queries, bodies and responses |
| **Language** | Arabic messages (the web's own text wherever one exists) |
| **Permissions** | The web route's permission names (`sales.invoices.*`, `sales.payments.*`, `sales.returns.*`, `sales.credit_notes.*`, `sales.exchanges.*`, `sales.quotes.*`, `sales.sales_orders.*`, `sales.daily_closing.*`, `sales.commissions.view`, `sales.reports.payments_by_employee`) |

## Implementation principle

A standalone TypeScript port of the **web controllers** in `Modules/Sales` (not the Laravel integration copy). The web controllers were not modified: every web bug found during the port is fixed in Node only and listed below under *Intended differences*.

## Gates

Every request passes, in order: subscription → application switch «إدارة المبيعات» (`application_settings`) → plan feature (`invoices`, `payments`, `return_invoices`, `credit_notes`, `product_exchanges`, `quotes`, `dashboard|reports` for daily closing, `reports`, `target_settings`) → permission. Failures: `402 PLAN_FEATURE_UNAVAILABLE / NO_SUBSCRIPTION`, `403 MODULE_DISABLED / FORBIDDEN`.

## List URLs shared with the sales section screens

`GET sales/invoices`, `sales/payments`, `sales/returns`, `sales/credit-notes` and `sales/quotes` are served by the **sales section screens** (registered first): query `page, perPage (≤50), search, status, period`, response `{ items, total, page, perPage, period }`. Every other sales route in this reference — including `GET sales/sales-orders` and all `/{id}` details — is served by this port.

**Usage limits** (`402 PLAN_LIMIT_REACHED`, the web's message): `sales_invoices`, `sales_payments` (a bulk collection is checked for the number of receipts it will write), `return_invoices`, `credit_notes`, `product_exchanges`, `quotes`, and the limits every document consumes: `warehouse_permits` (checked for the number of permits the document writes) and `journal_entries` (checked per entry inside the transaction). Used = max(billing snapshot, live count of the plan window). A limit reached mid-document rolls the whole document back.

## Data scope

Documents (invoices, returns, credit notes, exchanges, quotes) follow `ScopesSalesVisibility`: `data_scope_all` (or a legacy manager) sees all; a branch scope filters `branch_id`; otherwise `created_by` in the user's document users or `employee_id` in the user's document employees (the employee and his subordinates). The header branch narrows further (its subtree plus rows without a branch), except on the people axis or the main branch. Client choice follows the client visibility of the Clients section (`CLIENT_OUT_OF_SCOPE`). Payments: the collector (`payments_process.employee_id` = users.id) in scope, or the invoice in scope; `sales.payments.view_assigned_clients` restricts to the user's assigned clients. Daily closings: own only, all with `sales.daily_closing.view_all`.

## Settings honoured

`sales_invoice_settings`: max discount (percentage / amount, branch override), no sale below cost, coupons on/off, manual invoice/quote/order status, auto-pay from credit balance and from wallet, warehouse source (employee / main), custom journal description, apply offers to quotes, sales orders enabled, quotes disabled. Accounting accounts (`accounting_settings`): `sales`, `vat_payable`, `shipping_vat_payable`, `shipping_revenue`, `allowed_discount`, `cost_of_sales`, `sales_returns`, `shipping_revenue_returns`, `main_treasury`, `warehouse_accounts_parent` (a warehouse without an account gets one under it), `client_wallets_parent`, `cash_treasuries_parent`, `bank_accounts_parent`. A required account that is not mapped stops the document with `ACCOUNT_NOT_MAPPED`. Taxes from «إعدادات الضريبة» (included / excluded), order sources (mandatory flag), treasury deposit/withdraw rules, client proximity radius, document numbering sections (`invoice`, `invoice-payment`, `return-invoice`, `credit-note`, `product-exchange`, `quotation`, `sales-order`) — numbers are always server-issued; a number in the request is ignored.

## Document calculation

The chain of `DocumentTaxCalculator`: line gross − line discount (manual, or the matching discount offer when none) = line net → document discount (and coupon) allocated across lines in proportion to their nets (remainder on the last) → tax per line on its base (included extracted, excluded added) → shipping and its tax (tax chosen for shipping, otherwise the lines' taxes). Verified identical to PHP on 4,000 random invoices and 30,010 rounding values. Every journal entry is written balanced: a rounding cent is absorbed by the revenue line.

## Intended differences from the web

| Area | Web | Node |
|---|---|---|
| Invoice input | no validation (negative quantities, unknown taxes, units of another product accepted) | full validation; units must belong to the product; taxes must exist |
| Invoice permits and gift lines | warehouse of the last line / leftover variable | each line's own warehouse |
| Invoice entries | dated `now()` | dated the invoice date |
| Invoice currency | not written | written |
| `taxs_invoice` | computed before the document discount, `tax_2` missing | after the discount, both taxes, equals `tax_total` |
| Cost entry | failure swallowed; one inventory account for all lines | failure rolls back; each line's warehouse account |
| Payment status | forced 4/5 accepted; `is_paid=0` treated as paid | 1–3 only with manual status; `false`/`0` means not paid |
| Credit limits | debts summed with wallet accounts | ledger accounts only |
| Proximity | falls back to a stale saved location | current location required |
| Client scope on create | not checked | checked (`CLIENT_OUT_OF_SCOPE`) |
| Gift offer with minimum 0 | division by zero | skipped |
| Internal notifications quota | exhausted quota rolls back the sale | the notification is skipped, the sale stands |
| Numbering | — | `invoice`, `return-invoice`, `quotation`/`sales-order` (scoped), `credit-note`, `product-exchange` skip codes already taken |
| Collection ceiling | total − receipts (wallet-paid part collectable twice) | also minus wallet-paid and credit-note settlements |
| Collection balances | client balance decremented by hand after the recomputation (twice) | balances derived from entries only |
| Collection on a credit-noted / voided / instalment invoice | allowed | refused with the reason |
| Payment show vs list | list shows receipts the show then refuses | same rule for both |
| Bulk collection | no period/limit/return/scope guards, one reference for all, treasury credited with the typed amount, currency hardcoded | same guards as single, one number and one entry per receipt, treasury gets only what was distributed |
| Returns | anyone with the permission returns any invoice; price/discount/tax from the request; status forced 4; one permit per line each carrying the document total; tax rows pre-discount; the whole cash paid refunded | invoice scope checked; lines rebuilt from the original (price, taxes, proportional discount); computed status; one permit per warehouse; tax rows after discount; only the overpayment refunded (paid − value kept); refund row carries treasury and client |
| Credit notes | free notes accept any quantity at any price; cancel overwrites the creator; cancelled notes counted in daily closing returns | free notes limited to what was sold to the client and the last sale price; creator kept; cancelled excluded |
| Exchanges | rejections return JSON with the transaction open; photo kept after a failed save; employee warehouses silently swapped; integer pieces only; services accepted | full rollback; photo deleted; outside warehouses refused (`WAREHOUSE_FORBIDDEN`); units converted to base; stockless products refused |
| Quotes / orders | disabled documents reachable by URL; conversion re-implements the invoice | disabled → `DOCUMENT_DISABLED`; conversion through the invoice engine, locked in its transaction (no double conversion); a quote past its expiry date is not converted |
| Daily closing | existence checked outside the transaction (double close on retry) | user row locked, checked again inside |

## Not ported

Periodic and recurring invoices, instalment management, e-invoicing, offers/gifts/shipping/order-source setup (read only), document designs, the manager's targets screens, target settlements and commission payouts, and the per-client **collections report** (`CollectionsReportController`). The points system is not applied by Node.
