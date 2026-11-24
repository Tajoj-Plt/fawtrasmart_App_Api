# Manual for fawtrasmart Api doc - Sales (Node) :

-Api_url_based : `{base_url}/api/v1/`

-Headers_required : `Accept: application/json`

---

| process name | Invoice screen data |
|---|---|
| API_End point | `GET sales/invoices/create-data` |
| description | next number, invoice settings, taxes, payment methods, order sources, sale warehouses, treasuries, price lists |
| Auth_method | Bearer token |
| permission | sales.invoices.create |
| req_parameters | none |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED |
| res_body | `data : { nextNumber, currency, rules{ noSellBelowCost, enableMaxDiscount, maxDiscountType, maxDiscountPercent, maxDiscountAmount, autoPayIfBalance, autoPayFromWallet, manualInvoiceStatus, defaultPaidStatus, enableCoupons, selectPriceList, showInvoiceProfit, customJournalDescription, warehouseSource }, permissions{ bypassLocation, invoiceDebtClients }, taxes[ { id, name, rate, type } ], paymentMethods[ { id, name, code, isDefault } ], orderSources{ mandatory, defaultId, list[] }, warehouses[ { id, name } ], treasuries[ { accountId, name, type } ], priceLists[] }` |

---

| process name | Sale catalog |
|---|---|
| API_End point | `GET sales/catalog` |
| description | sellable products of the sale warehouse with units and available quantity |
| Auth_method | Bearer token |
| permission | sales.invoices.create |
| req_parameters | 1- warehouseId (optional) 2- search (optional) 3- productIds (comma list, optional) 4- page (optional) 5- perPage (1-200, optional) |
| Status_Code | 200 - success , 402 , 403 - FORBIDDEN / WAREHOUSE_FORBIDDEN , 422 - validation |
| res_body | `data : { warehouseId, total, page, perPage, lastPage, items[ { id, name, barcode, serialNumber, type, salePrice, purchasePrice, minSalePrice, availableQuantity, tax1Id, tax2Id, hasUnits, units[ { id, categoryUnitId, name, conversionFactor, isBaseUnit, isDefault, salePrice, purchasePrice, barcode } ] } ] }` |

---

| process name | Price list price |
|---|---|
| API_End point | `GET sales/price` |
| description | product price in a price list |
| Auth_method | Bearer token |
| permission | sales.invoices.create |
| req_parameters | 1- priceListId (required) 2- productId (required) |
| Status_Code | 200 - success , 402 , 403 , 422 - validation |
| res_body | `data : { price }` |

---

| process name | Check coupon |
|---|---|
| API_End point | `POST sales/coupons/check` |
| description | preview a coupon before saving |
| Auth_method | Bearer token |
| permission | sales.invoices.create |
| req_parameters | 1- code (required) 2- clientId (optional) 3- amount (optional) 4- productIds (optional) 5- shippingCost (optional) |
| Status_Code | 200 - success , 402 , 403 - FORBIDDEN / CLIENT_OUT_OF_SCOPE , 422 - validation |
| res_body | `data : { ok, code, discount, freeShipping, message }` |

---

| process name | List invoices |
|---|---|
| API_End point | `GET sales/invoices` |
| description | sales section list (invoices in the user's scope) |
| Auth_method | Bearer token |
| permission | sales.invoices.view |
| req_parameters | 1- page 2- perPage (max 50) 3- search 4- status 5- period |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED , 404 - SECTION_NOT_FOUND , 422 - validation |
| res_body | `data : { items[ { id, code, date, clientName, grandTotal, paymentStatus, currency } ], total, page, perPage, period }` |

---

| process name | Create invoice |
|---|---|
| API_End point | `POST sales/invoices` |
| description | issue a sales invoice: stock out, SI + cost entries, advance receipt, wallet / credit balance settlement |
| Auth_method | Bearer token |
| permission | sales.invoices.create (+ sales.invoices.bypass_location to skip the proximity check, + Issue_an_invoice_to_a_customer_who_has_a_debt for debtor clients without a credit limit) |
| req_parameters | 1- clientId (required) 2- items[ { productId, unitId / categoryUnitId, quantity, unitPrice, discount, discountType (amount/percentage), tax1Id, tax2Id, warehouseId, description } ] (required) 3- invoiceDate 4- issueDate 5- terms 6- employeeId 7- warehouseId 8- orderSourceId 9- discountAmount 10- discountType 11- couponCode 12- shippingCost 13- shippingTaxId 14- advancePayment 15- isPaid 16- paymentStatus (1-3, only with manual status) 17- paymentMethod 18- treasuryId (account id) 19- referenceNumber 20- journalDescription 21- notes 22- currentLatitude 23- currentLongitude (required for employees without bypass) |
| Status_Code | 201 - created , 402 - PLAN_FEATURE_UNAVAILABLE / PLAN_LIMIT_REACHED , 403 - FORBIDDEN / CLIENT_OUT_OF_SCOPE / WAREHOUSE_FORBIDDEN / TREASURY_FORBIDDEN , 422 - validation / INSUFFICIENT_STOCK / CREDIT_LIMIT_EXCEEDED / CLIENT_HAS_DEBT / OUT_OF_RANGE / CLIENT_LOCATION_MISSING / ACCOUNTING_PERIOD_CLOSED / CLIENT_ACCOUNT_MISSING / ACCOUNT_NOT_MAPPED |
| res_body | `message , data : { invoice details (same as show) }` |

---

| process name | Show invoice |
|---|---|
| API_End point | `GET sales/invoices/{id}` |
| description | invoice with items and payments |
| Auth_method | Bearer token |
| permission | sales.invoices.view (+ sales.invoices.view_assigned_clients for assigned clients) |
| req_parameters | none |
| Status_Code | 200 - success , 402 , 403 - FORBIDDEN / INVOICE_FORBIDDEN , 404 - INVOICE_NOT_FOUND |
| res_body | `data : { …list item, notes, qrcode, items[ { id, productId, item, description, unitName, productUnitId, warehouse{ id, name }, quantity, quantityInBaseUnit, conversionFactor, unitPrice, discount, discountType, tax1, tax1Id, tax2, tax2Id, total, isGift } ], payments[ { id, amount, paymentDate, reference, method, createdAt } ] }` |

---

| process name | Print invoice |
|---|---|
| API_End point | `GET sales/invoices/{id}/print` |
| description | business data + invoice + ZATCA QR (base64 TLV) |
| Auth_method | Bearer token |
| permission | sales.invoices.print |
| req_parameters | none |
| Status_Code | 200 - success , 402 , 403 , 404 |
| res_body | `data : { business{ name, taxNumber }, invoice{ same as show } }` |

---

| process name | Collection screen data |
|---|---|
| API_End point | `GET sales/payments/create-data` |
| description | depositable treasuries, payment methods, next receipt number |
| Auth_method | Bearer token |
| permission | sales.payments.create |
| req_parameters | none |
| Status_Code | 200 - success , 402 , 403 |
| res_body | `data : { treasuries[ { id, name, isOwn } ], defaultTreasuryId, paymentMethods[], nextNumber, periodBlock, canBulk }` |

---

| process name | Client unpaid invoices |
|---|---|
| API_End point | `GET sales/clients/{id}/unpaid-invoices` |
| description | open invoices of a client in scope, oldest first |
| Auth_method | Bearer token |
| permission | sales.payments.view |
| req_parameters | none |
| Status_Code | 200 - success , 402 , 403 - FORBIDDEN / CLIENT_OUT_OF_SCOPE , 404 - CLIENT_NOT_FOUND |
| res_body | `data : { invoices[ { id, code, invoiceDate, grandTotal, paid, dueValue, remaining, paymentStatus, paymentStatusLabel, partialAllowed, collectible, blockReason } ], totalDue }` |

---

| process name | List payments |
|---|---|
| API_End point | `GET sales/payments` |
| description | sales section list (client receipts in the user's scope) |
| Auth_method | Bearer token |
| permission | sales.payments.view |
| req_parameters | 1- page 2- perPage (max 50) 3- search 4- status 5- period |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED , 404 - SECTION_NOT_FOUND , 422 - validation |
| res_body | `data : { items[ { id, date, clientName, amount, method } ], total, page, perPage, period }` |

---

| process name | Collect payment |
|---|---|
| API_End point | `POST sales/payments` |
| description | receipt on one invoice + REC entry dated the payment date |
| Auth_method | Bearer token |
| permission | sales.payments.create |
| req_parameters | 1- invoiceId (required) 2- amount (required, > 0) 3- paymentDate 4- treasuryId (account id) 5- paymentMethod 6- notes |
| Status_Code | 201 - created , 402 - PLAN_LIMIT_REACHED , 403 - PAYMENT_FORBIDDEN / TREASURY_FORBIDDEN , 404 - INVOICE_NOT_FOUND , 422 - validation / INVOICE_NOT_COLLECTIBLE / INVOICE_SETTLED / PARTIAL_PAYMENT_BLOCKED / CLIENT_ACCOUNT_MISSING / ACCOUNTING_PERIOD_CLOSED |
| res_body | `message , data : { payment details }` |

---

| process name | Bulk collect |
|---|---|
| API_End point | `POST sales/payments/bulk` |
| description | one amount distributed over the selected invoices, oldest first — one receipt and one entry per invoice |
| Auth_method | Bearer token |
| permission | sales.payments.bulk |
| req_parameters | 1- clientId (required) 2- amount (required) 3- invoiceIds[] (required) 4- paymentDate 5- treasuryId 6- paymentMethod 7- notes |
| Status_Code | 201 - created , 402 - PLAN_LIMIT_REACHED , 403 , 422 - validation / INVOICES_NOT_COLLECTIBLE / NOTHING_TO_COLLECT / CLIENT_ACCOUNT_MISSING |
| res_body | `message , data : { distributed, unused, payments[ { id, number, invoiceCode, amount, paymentStatus, paymentStatusLabel } ], skipped[] }` |

---

| process name | Show payment |
|---|---|
| API_End point | `GET sales/payments/{id}` |
| description | receipt with its invoice and entry |
| Auth_method | Bearer token |
| permission | sales.payments.view |
| req_parameters | none |
| Status_Code | 200 - success , 402 , 403 - PAYMENT_FORBIDDEN , 404 - PAYMENT_NOT_FOUND |
| res_body | `data : { …list item, invoice{ id, code, grandTotal, paid, dueValue, paymentStatus }, journalEntry{ id, referenceNumber, date } }` |

---

| process name | Return screen data |
|---|---|
| API_End point | `GET sales/invoices/{id}/return-data` |
| description | returnable lines of an invoice, cash paid, refund estimate, withdrawable treasuries |
| Auth_method | Bearer token |
| permission | sales.returns.create |
| req_parameters | none |
| Status_Code | 200 - success , 402 , 403 , 404 |
| res_body | `data : { invoice{ id, code, client, grandTotal, paid, currency }, blockReason, lines[ { invoiceItemId, productId, item, unitName, maxQuantity, unitPrice, discount, total, warehouse } ], shipping{ cost, tax }, refundIfFullReturn, treasuries[], periodBlock, nextNumber }` |

---

| process name | Create return |
|---|---|
| API_End point | `POST sales/returns` |
| description | return of an invoice built from its own lines: stock back to each line's warehouse, SR + cost reversal entries, optional cash refund |
| Auth_method | Bearer token |
| permission | sales.returns.create (+ sales.returns.bypass_location) |
| req_parameters | 1- invoiceId (required) 2- items[ { invoiceItemId, quantity } ] (required) 3- returnDate 4- includeShipping 5- refund 6- treasuryId (account id) 7- paymentMethod 8- notes 9- currentLatitude 10- currentLongitude |
| Status_Code | 201 - created , 402 - PLAN_LIMIT_REACHED , 403 - INVOICE_FORBIDDEN / TREASURY_FORBIDDEN , 404 , 422 - validation / RETURN_BLOCKED / TREASURY_INSUFFICIENT / OUT_OF_RANGE / ACCOUNTING_PERIOD_CLOSED |
| res_body | `message , data : { return details }` |

---

| process name | List returns |
|---|---|
| API_End point | `GET sales/returns` |
| description | sales section list (return invoices in the user's scope) |
| Auth_method | Bearer token |
| permission | sales.returns.view |
| req_parameters | 1- page 2- perPage (max 50) 3- search 4- status 5- period |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED , 404 - SECTION_NOT_FOUND , 422 - validation |
| res_body | `data : { items[ { id, code, date, clientName, grandTotal, paymentStatus, currency } ], total, page, perPage, period }` |

---

| process name | Show return |
|---|---|
| API_End point | `GET sales/returns/{id}` |
| description | return invoice with its lines and refunds |
| Auth_method | Bearer token |
| permission | sales.returns.view |
| req_parameters | none |
| Status_Code | 200 - success , 402 , 403 - RETURN_FORBIDDEN , 404 - RETURN_NOT_FOUND |
| res_body | `data : { id, code, client, branch, employee, createdBy, returnDate, currency, subtotal, discountAmount, shippingCost, shippingTax, taxTotal, grandTotal, refunded, dueValue, paymentStatus, paymentStatusLabel, originalInvoice{ id, code, grandTotal }, items[], refunds[] }` |

---

| process name | Credit note screen data |
|---|---|
| API_End point | `GET sales/credit-notes/create-data` |
| description | client's invoices eligible for a credit note, warehouses, taxes |
| Auth_method | Bearer token |
| permission | sales.credit_notes.create |
| req_parameters | 1- clientId (required) |
| Status_Code | 200 - success , 402 , 403 , 404 |
| res_body | `data : { invoices[ { id, code, invoiceDate, grandTotal } ], warehouses[], taxes[], periodBlock, nextNumber }` |

---

| process name | Settlement preview |
|---|---|
| API_End point | `GET sales/credit-notes/settlement-preview` |
| description | how an amount would settle: referenced invoice, previous balance, then oldest invoices |
| Auth_method | Bearer token |
| permission | sales.credit_notes.create |
| req_parameters | 1- clientId (required) 2- amount (required) 3- invoiceId (optional) |
| Status_Code | 200 - success , 402 , 403 , 404 , 422 |
| res_body | `data : { previousBalance, previousPay, invoices[ { id, code, date, total, due, pay } ], unallocated }` |

---

| process name | Create credit note |
|---|---|
| API_End point | `POST sales/credit-notes` |
| description | on an invoice (lines from it) or free (quantity within what was sold to the client, price ≤ last sale price); stock back, CN + cost entries, settlement |
| Auth_method | Bearer token |
| permission | sales.credit_notes.create (+ sales.credit_notes.bypass_location) |
| req_parameters | 1- clientId (required) 2- items (required): with invoiceId `[ { invoiceItemId, quantity } ]`, without `[ { productId, unitId, quantity, unitPrice, discount, discountType, tax1Id, tax2Id, warehouseId, description } ]` 3- invoiceId 4- creditDate 5- releaseDate 6- includeShipping 7- employeeId 8- notes 9- currentLatitude 10- currentLongitude |
| Status_Code | 201 - created , 402 - PLAN_LIMIT_REACHED , 403 , 404 , 422 - validation / CREDIT_NOTE_BLOCKED / ACCOUNTING_PERIOD_CLOSED / CLIENT_ACCOUNT_MISSING |
| res_body | `message , data : { credit note details }` |

---

| process name | List credit notes |
|---|---|
| API_End point | `GET sales/credit-notes` |
| description | sales section list (credit notes in the user's scope) |
| Auth_method | Bearer token |
| permission | sales.credit_notes.view |
| req_parameters | 1- page 2- perPage (max 50) 3- search 4- status 5- period |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED , 404 - SECTION_NOT_FOUND , 422 - validation |
| res_body | `data : { items[ { id, number, date, clientName, grandTotal, status } ], total, page, perPage, period }` |

---

| process name | Show credit note |
|---|---|
| API_End point | `GET sales/credit-notes/{id}` |
| description | credit note with its lines and settlement |
| Auth_method | Bearer token |
| permission | sales.credit_notes.view |
| req_parameters | none |
| Status_Code | 200 - success , 402 , 403 - CREDIT_NOTE_FORBIDDEN , 404 |
| res_body | `data : { id, number, client, branch, invoice, createdBy, creditDate, releaseDate, currency, subtotal, totalDiscount, shippingCost, shippingTax, totalTax, grandTotal, status, statusLabel, cancelled, items[], settlement{ previousBalance, invoices[ { invoiceId, amount } ] } }` |

---

| process name | Cancel credit note |
|---|---|
| API_End point | `POST sales/credit-notes/{id}/cancel` |
| description | reverse stock, settlement and every entry (reversal entries dated today) |
| Auth_method | Bearer token |
| permission | sales.credit_notes.cancel + data_scope_all |
| req_parameters | none |
| Status_Code | 200 - success , 402 , 403 - CREDIT_NOTE_CANCEL_FORBIDDEN , 404 , 422 - CREDIT_NOTE_CANCELLED / INSUFFICIENT_STOCK / ACCOUNTING_PERIOD_CLOSED |
| res_body | `message , data : { credit note details }` |

---

| process name | Exchange reasons / screen data |
|---|---|
| API_End point | `GET sales/exchange-reasons` , `GET sales/exchanges/create-data` |
| description | active reasons ; allowed warehouses, reasons, employee daily limit and today's usage |
| Auth_method | Bearer token |
| permission | sales.exchanges.view ; sales.exchanges.create |
| req_parameters | none |
| Status_Code | 200 - success , 402 , 403 |
| res_body | `data : [ { id, name, description } ]` ; `data : { warehouses[], reasons[], employeeDailyLimit, employeeUsedToday, periodBlock, nextNumber }` |

---

| process name | Create exchange |
|---|---|
| API_End point | `POST sales/exchanges` |
| description | same goods out of one warehouse, damaged back into another, at average cost — permits 27/28, PEX entries, photo to the ERP |
| Auth_method | Bearer token |
| permission | sales.exchanges.create |
| req_parameters | multipart/form-data: 1- clientId (required) 2- storehouseId (required) 3- returnStorehouseId (required, different) 4- image (required, image ≤ 5 MB) 5- items (JSON) `[ { productId, unitId, quantity, reasonId, reasonNotes } ]` (required) 6- exchangeDate 7- employeeId 8- notes |
| Status_Code | 201 - created , 402 - PLAN_LIMIT_REACHED , 403 - CLIENT_OUT_OF_SCOPE / WAREHOUSE_FORBIDDEN , 422 - validation / INSUFFICIENT_STOCK / EXCHANGE_LIMIT / ACCOUNTING_PERIOD_CLOSED |
| res_body | `message , data : { exchange details }` |

---

| process name | List / Show exchanges |
|---|---|
| API_End point | `GET sales/exchanges` , `GET sales/exchanges/{id}` |
| description | exchanges in scope |
| Auth_method | Bearer token |
| permission | sales.exchanges.view |
| req_parameters | list: page, perPage, clientId, code, branch, fromDate, toDate |
| Status_Code | 200 - success , 402 , 403 - EXCHANGE_FORBIDDEN , 404 |
| res_body | `data : { id, code, client, employee, createdBy, storehouse, returnStorehouse, exchangeDate, totalValue, image, status, createdAt, notes, items[ { id, productId, productName, quantity, unitPrice, total, reasonId, reasonName, reasonNotes } ] }` |

---

| process name | Quotes / Sales orders |
|---|---|
| API_End point | `POST sales/quotes` , `GET sales/quotes/{id}` , `PUT sales/quotes/{id}` , `DELETE sales/quotes/{id}` — and `GET/POST sales/sales-orders` , `GET/PUT/DELETE sales/sales-orders/{id}` (`GET sales/quotes` is the sales section list: items[ { id, number, date, clientName, grandTotal } ], total, page, perPage, period) |
| description | quote / sales order documents (sales orders only when enabled in invoice settings) |
| Auth_method | Bearer token |
| permission | sales.quotes.view / create / edit / delete — sales.sales_orders.* |
| req_parameters | body: 1- clientId (required) 2- items[ { productId, unitId, quantity, unitPrice, discount, discountType, tax1Id, tax2Id, description } ] (required) 3- quoteDate 4- expiryDate (quotes) 5- employeeId 6- terms 7- discountAmount 8- discountType 9- shippingCost 10- shippingTaxId 11- taxType (1/2/3) 12- status (manual status only) 13- notes ; sales-orders list: page, perPage, clientId, number, status, fromDate, toDate |
| Status_Code | 200 / 201 , 402 - PLAN_LIMIT_REACHED , 403 - DOCUMENT_DISABLED / QUOTE_FORBIDDEN / CLIENT_OUT_OF_SCOPE , 404 , 422 - validation / QUOTE_LOCKED / ACCOUNTING_PERIOD_CLOSED |
| res_body | `data : { id, type, number, client, employee, createdBy, invoice, date, expiryDate, paymentTerms, currency, discountType, discountAmount, shippingCost, shippingTax, taxType, subtotal, totalDiscount, totalTax, grandTotal, status, statusLabel, notes, items[] }` |

---

| process name | Convert to invoice |
|---|---|
| API_End point | `POST sales/quotes/{id}/convert` , `POST sales/sales-orders/{id}/convert` |
| description | issues the invoice through the invoice engine and marks the document converted in the same transaction |
| Auth_method | Bearer token |
| permission | sales.quotes.convert / sales.sales_orders.convert |
| req_parameters | optional: warehouseId, isPaid, advancePayment, paymentMethod, treasuryId, orderSourceId, currentLatitude, currentLongitude |
| Status_Code | 201 - created , 402 , 403 , 404 , 422 - QUOTE_CONVERTED / QUOTE_CANCELLED / QUOTE_EXPIRED / QUOTE_EMPTY / all invoice errors |
| res_body | `message , data : { invoice{…}, quote{…} or salesOrder{…} }` |

---

| process name | Daily closing |
|---|---|
| API_End point | `GET sales/daily-closing` , `GET sales/daily-closing/{id}` , `GET sales/daily-closing/system-data` , `GET sales/daily-closing/stock-products` , `POST sales/daily-closing` , `POST sales/daily-closing/auto` |
| description | the user's closings ; system figures for a day ; stock of the user's warehouses + visits ; manual closing (must match the system) ; automatic closing |
| Auth_method | Bearer token |
| permission | sales.daily_closing.view (view_all for others) ; review ; create ; create ; auto_close or review |
| req_parameters | list: page, employeeId (view_all), fromDate, toDate ; system-data: date (required) ; stock-products: date ; store: date, reportedSales, reportedCashSales, reportedReceipts, reportedReturns, reportedCashRefunds, reportedExpenses, stockProducts[ { productId, reportedQuantity } ] ; auto: date |
| Status_Code | 200 / 201 , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - CLOSING_FORBIDDEN , 404 , 422 - validation / ALREADY_CLOSED / CLOSING_MISMATCH / ACCOUNTING_PERIOD_CLOSED |
| res_body | system-data: `data : { sales, cashSales, receipts, cashRefunds, collections, returns, expenses, stockTotal, stockProducts[ { productId, productName, systemQuantity } ], visits{ completed[], missed[], completedCount, missedCount, successCount, negativeCount, totalMinutes, totalDuration } }` ; closing: `data : { id, employeeId, employeeName, date, status, notes, reported{}, system{}, stock[], createdAt }` |

---

| process name | My targets |
|---|---|
| API_End point | `GET sales/my/targets` |
| description | the user's sales and collection targets with achievement, commission and applied tier |
| Auth_method | Bearer token |
| permission | plan feature target_settings |
| req_parameters | 1- fromDate (default first of month) 2- toDate (default today) |
| Status_Code | 200 - success , 402 , 403 , 422 |
| res_body | `data : { range, sales[ { id, name, period, method, methodLabel, targetAmount, achieved, remaining, percentage, commissionPercentage, appliedTier, commission, breakdown{} } ], collections[ … ] }` |

---

| process name | My commissions |
|---|---|
| API_End point | `GET sales/my/commissions` |
| description | pending weekly commissions and those paid in the last 30 days |
| Auth_method | Bearer token |
| permission | sales.commissions.view |
| req_parameters | none |
| Status_Code | 200 - success , 403 |
| res_body | `data : { employee, pending[ { id, target, amount, fromDate, toDate, paidAt, notes, createdAt } ], paid[], totalPending, totalPaidLast30Days, treasury{ id, name, balance } }` |

---

| process name | Payments by employee |
|---|---|
| API_End point | `GET sales/reports/payments-by-employee` |
| description | cash that entered treasuries/banks from clients, minus return refunds, grouped |
| Auth_method | Bearer token |
| permission | sales.reports.payments_by_employee + plan feature reports |
| req_parameters | 1- fromDate 2- toDate 3- employeeId 4- clientId 5- groupBy (employee/day/month/client/treasury) 6- view (summary/details) |
| Status_Code | 200 - success , 402 , 403 , 422 |
| res_body | `data : { range, groupBy, totals{ count, amount, grossAmount, refundsCount, refundsAmount }, groups[ { key, name, count, refundsCount, amount, items[] } ] }` |
