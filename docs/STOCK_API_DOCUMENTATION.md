# Manual for fawtrasmart Api doc - Stock (Node) :

-Api_url_based : `{base_url}/api/v1/`

-Headers_required : `Accept: application/json`

---

| process name | List warehouses |
|---|---|
| API_End point | `GET stock/warehouses` |
| description | stock section list (warehouses in the user's scope) |
| Auth_method | Bearer token |
| permission | stock.warehouses.view |
| req_parameters | 1- page 2- perPage (max 50) 3- search 4- status |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED , 404 - SECTION_NOT_FOUND , 422 - validation |
| res_body | `data : { items[ { id, name, status, isMain, branchId } ], total, page, perPage }` |

---

| process name | Warehouse details |
|---|---|
| API_End point | `GET stock/warehouses/{id}` |
| description | products, quantities, value and log of one warehouse |
| Auth_method | Bearer token |
| permission | stock.warehouses.view + stock.warehouses.show |
| req_parameters | none |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED / WAREHOUSE_FORBIDDEN , 404 - WAREHOUSE_NOT_FOUND |
| res_body | `data : { warehouse{ same as list item }, items[ { id, name, barcode, currentQuantity, incomingManual, incomingOpening, incomingTransfer, incomingTotal, outgoingManual, outgoingTransfer, sold, salesReturns, withdrawnTotal, unitCost, stockValue } ], totals{ currentQuantity, incomingManual, incomingOpening, incomingTransfer, incomingTotal, outgoingManual, outgoingTransfer, sold, salesReturns, withdrawnTotal }, totalStockValue, accountBalance, valueDifference, logs[ { date, description, user } ] }` |

---

| process name | Warehouse movements |
|---|---|
| API_End point | `GET stock/warehouses/{id}/movements` |
| description | movement summary per product |
| Auth_method | Bearer token |
| permission | stock.reports.summary_movement |
| req_parameters | 1- keywords (optional) 2- category (optional) 3- operationType (incoming / outgoing / transfer, optional) |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED / WAREHOUSE_FORBIDDEN , 404 - WAREHOUSE_NOT_FOUND , 422 - validation |
| res_body | `data : { items[ { id, name, incomingManual, incomingOpening, incomingTransfer, outgoingManual, outgoingTransfer, incomingTotal, outgoingTotal, movementTotal, soldQuantity, salesReturnQuantity } ], storehouse{ id, name, status, shippingAddress, branchId }, categories[ { id, name } ] }` |

---

| process name | Statement warehouses |
|---|---|
| API_End point | `GET stock/statement/warehouses` |
| description | warehouses for the statement picker |
| Auth_method | Bearer token |
| permission | stock.reports.employee_statement |
| req_parameters | none |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED |
| res_body | `data : [ { id, name } ]` |

---

| process name | Warehouse statement |
|---|---|
| API_End point | `GET stock/statement` |
| description | stock statement with running balance (good / damaged) |
| Auth_method | Bearer token |
| permission | stock.reports.employee_statement |
| req_parameters | 1- warehouse (optional) 2- startDate (YYYY-MM-DD, optional) 3- endDate (YYYY-MM-DD, optional) 4- periodId (all / none / year:{id} / {periodId}, optional) 5- product (optional) 6- category (optional) 7- brand (optional) 8- permissionSource (optional) |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED , 404 - NO_WAREHOUSES , 422 - validation |
| res_body | `data : { warehouse{ id, name }, startDate, endDate, statement{ openingBalance, totalIncoming, totalOutgoing, closingBalance, goodStock, damagedStock, currentStock, movements[ { id, date, type, reference, productName, productCode, quantity, incoming, outgoing, balanceBefore, balanceAfter, balance, goodBalance, damagedBalance, isDamaged, exchangeReason, userName, notes, clientTradeName, clientCode, transferInfo{ from, to } } ], startDate, endDate }, products[ { id, name, serialNumber } ] }` |

---

| process name | List permits |
|---|---|
| API_End point | `GET stock/permits` |
| description | stock section list (permits in the user's scope) |
| Auth_method | Bearer token |
| permission | stock.permits.view |
| req_parameters | 1- page 2- perPage (max 50) 3- search 4- status |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED , 404 - SECTION_NOT_FOUND , 422 - validation |
| res_body | `data : { items[ { id, number, permissionType, permissionDate, status, storeHouseName, fromStoreHouseName, toStoreHouseName, grandTotal } ], total, page, perPage }` |

---

| process name | Permit form data |
|---|---|
| API_End point | `GET stock/permits/create-data` |
| description | warehouses, products and next number for a permit type |
| Auth_method | Bearer token |
| permission | stock.permits.create_addition / stock.permits.create_disbursement / stock.permits.create_transfer / stock.permits.create_opening (the one of the type) |
| req_parameters | 1- type (1 addition / 2 disbursement / 3 transfer / 4 opening balance) |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED , 422 - validation |
| res_body | `data : { type, serialNumber, warehouses[ { id, name } ], products[ { id, name, barcode, purchasePrice, salePrice } ] }` |

---

| process name | Product stock |
|---|---|
| API_End point | `GET stock/permits/product-stock/{warehouseId}/{productId}` |
| description | available quantity of a product in a warehouse |
| Auth_method | Bearer token |
| permission | stock.permits.view |
| req_parameters | none |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED / WAREHOUSE_FORBIDDEN , 404 - PRODUCT_NOT_FOUND |
| res_body | `data : { stock, formatted }` |

---

| process name | Permit details |
|---|---|
| API_End point | `GET stock/permits/{id}` |
| description | permit with lines and log |
| Auth_method | Bearer token |
| permission | stock.permits.show |
| req_parameters | none |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED / RECORD_FORBIDDEN , 404 - PERMIT_NOT_FOUND |
| res_body | `data : { id, number, type, typeLabel, status, date, warehouse, fromWarehouse, toWarehouse, grandTotal, currency, details, createdBy, canEdit, canDelete, canApprove, canReject, canCancelApproval, items[ { id, productId, productName, quantity, unitPrice, total } ], attachments, rejectionReason, logs[ { date, description } ] }` |

---

| process name | Add permit |
|---|---|
| API_End point | `POST stock/permits` |
| description | add permit (JSON or multipart/form-data) — opening balance is approved on save |
| Auth_method | Bearer token |
| permission | stock.permits.create_addition / stock.permits.create_disbursement / stock.permits.create_transfer / stock.permits.create_opening (the one of permissionType) |
| req_parameters | 1- permissionType (1-4) 2- permissionDate (YYYY-MM-DD or YYYY-MM-DD HH:MM) 3- warehouseId (types 1, 2, 4) 4- fromWarehouseId (type 3) 5- toWarehouseId (type 3) 6- grandTotal 7- details (optional) 8- items[ { productId, quantity, unitPrice, total } ] (JSON string in multipart) 9- attachments (jpeg / png / pdf ≤ 5 MB, optional) |
| Status_Code | 201 - created , 402 - PLAN_FEATURE_UNAVAILABLE / PLAN_LIMIT_REACHED , 403 - FORBIDDEN / MODULE_DISABLED , 422 - validation / PRODUCTS_INACTIVE / STOCKLESS_PRODUCT / INSUFFICIENT_STOCK / ACCOUNTING_PERIOD_CLOSED / PERMIT_STORE_FAILED / PERMIT_APPROVAL_FAILED , 502 - MEDIA_UPLOAD_FAILED , 503 - UPLOADS_NOT_CONFIGURED |
| res_body | `{ success, message, data : { id, number, status } }` |

---

| process name | Update permit |
|---|---|
| API_End point | `PUT stock/permits/{id}` (also `POST stock/permits/{id}`) |
| description | update pending permit (JSON or multipart/form-data) |
| Auth_method | Bearer token |
| permission | stock.permits.edit + permission of permissionType |
| req_parameters | same as add permit (attachments optional) |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED / RECORD_FORBIDDEN , 404 - PERMIT_NOT_FOUND , 422 - validation / PRODUCTS_INACTIVE / STOCKLESS_PRODUCT / PERMIT_NOT_PENDING , 502 - MEDIA_UPLOAD_FAILED , 503 - UPLOADS_NOT_CONFIGURED |
| res_body | `{ success, message, data : null }` |

---

| process name | Delete permit |
|---|---|
| API_End point | `DELETE stock/permits/{id}` |
| description | delete permit that is not approved |
| Auth_method | Bearer token |
| permission | stock.permits.delete |
| req_parameters | none |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED / RECORD_FORBIDDEN , 404 - PERMIT_NOT_FOUND , 422 - PERMIT_APPROVED |
| res_body | `{ success, message, data : null }` |

---

| process name | Reject permit |
|---|---|
| API_End point | `POST stock/permits/{id}/reject` |
| description | reject pending permit |
| Auth_method | Bearer token |
| permission | stock.permits.reject |
| req_parameters | 1- reason (or rejectionReason, max 5000, optional) |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED / RECORD_FORBIDDEN , 404 - PERMIT_NOT_FOUND , 422 - validation / PERMIT_APPROVED / PERMIT_NOT_PENDING / PERMIT_REJECT_FAILED |
| res_body | `{ success, message, data : null }` |

---

| process name | Approve permit |
|---|---|
| API_End point | `POST stock/permits/{id}/approve` |
| description | approve: move quantities and create journal entry |
| Auth_method | Bearer token |
| permission | stock.permits.approve |
| req_parameters | none |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE / PLAN_LIMIT_REACHED , 403 - FORBIDDEN / MODULE_DISABLED / RECORD_FORBIDDEN , 404 - PERMIT_NOT_FOUND , 422 - PERMIT_APPROVAL_FAILED / ACCOUNTING_PERIOD_CLOSED / PLAN_LIMIT_REACHED |
| res_body | `{ success, message, data : { id, status } }` |

---

| process name | Cancel approval |
|---|---|
| API_End point | `POST stock/permits/{id}/cancel-approval` |
| description | return quantities and reverse journal entries |
| Auth_method | Bearer token |
| permission | stock.permits.cancel_approval |
| req_parameters | none |
| Status_Code | 200 - success , 400 - PERMIT_NOT_APPROVED , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED / RECORD_FORBIDDEN , 404 - PERMIT_NOT_FOUND , 422 - ACCOUNTING_PERIOD_CLOSED , 500 - CANCEL_APPROVAL_FAILED |
| res_body | `{ success, message, data : { id, status } }` |

---

| process name | List price lists |
|---|---|
| API_End point | `GET stock/price-lists` |
| description | price lists (10 per page) |
| Auth_method | Bearer token |
| permission | stock.price_lists.view |
| req_parameters | 1- keywords (optional) 2- product (optional) 3- category (optional) 4- brand (optional) 5- status (0 active / 1 stopped, optional) 6- page (optional) |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED , 422 - validation |
| res_body | `data : { items[ { id, name, status, createdAt, canEdit, canDelete, canManageProducts } ], total, page, perPage, lastPage }` |

---

| process name | Price list details |
|---|---|
| API_End point | `GET stock/price-lists/{id}` |
| description | price list with its products |
| Auth_method | Bearer token |
| permission | stock.price_lists.show |
| req_parameters | none |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED , 404 - PRICE_LIST_NOT_FOUND |
| res_body | `data : { id, name, status, createdAt, canEdit, canDelete, canManageProducts, items[ { itemId, productId, name, salePrice } ], availableProducts[ { id, name, salePrice } ] }` |

---

| process name | Add price list |
|---|---|
| API_End point | `POST stock/price-lists` |
| description | add price list |
| Auth_method | Bearer token |
| permission | stock.price_lists.create |
| req_parameters | 1- name (max 255) 2- status (0 / 1, optional, default 0) |
| Status_Code | 201 - created , 402 - PLAN_FEATURE_UNAVAILABLE / PLAN_LIMIT_REACHED , 403 - FORBIDDEN / MODULE_DISABLED , 422 - validation |
| res_body | `{ success, message, data : { id, name, status, createdAt, canEdit, canDelete, canManageProducts } }` |

---

| process name | Update price list |
|---|---|
| API_End point | `PUT stock/price-lists/{id}` |
| description | update price list |
| Auth_method | Bearer token |
| permission | stock.price_lists.edit |
| req_parameters | 1- name (max 255) 2- status (0 / 1, optional, kept when absent) |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED , 404 - PRICE_LIST_NOT_FOUND , 422 - validation |
| res_body | `{ success, message, data : null }` |

---

| process name | Delete price list |
|---|---|
| API_End point | `DELETE stock/price-lists/{id}` |
| description | delete price list |
| Auth_method | Bearer token |
| permission | stock.price_lists.delete |
| req_parameters | none |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED , 404 - PRICE_LIST_NOT_FOUND |
| res_body | `{ success, message, data : null }` |

---

| process name | Add product to price list |
|---|---|
| API_End point | `POST stock/price-lists/{id}/products` |
| description | add product with its sale price |
| Auth_method | Bearer token |
| permission | stock.price_lists.manage_products |
| req_parameters | 1- productId 2- salePrice |
| Status_Code | 201 - created , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED / PRODUCT_FORBIDDEN , 404 - PRICE_LIST_NOT_FOUND , 422 - validation |
| res_body | `{ success, message, data : { itemId, productId, salePrice } }` |

---

| process name | Remove product from price list |
|---|---|
| API_End point | `DELETE stock/price-lists/products/{itemId}` |
| description | remove product line (itemId from price list details) |
| Auth_method | Bearer token |
| permission | stock.price_lists.manage_products |
| req_parameters | none |
| Status_Code | 200 - success , 402 - PLAN_FEATURE_UNAVAILABLE , 403 - FORBIDDEN / MODULE_DISABLED , 404 - PRICE_LIST_ITEM_NOT_FOUND |
| res_body | `{ success, message, data : null }` |
