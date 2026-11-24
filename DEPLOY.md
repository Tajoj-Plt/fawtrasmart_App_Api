# Deploying MobileAppBackend on Hostinger (Node.js Web App)

Verified locally: clean `npm ci --omit=dev` (builds by itself), `npm start` with `dist/` deleted (builds by itself), `node index.js`, and `node dist/interfaces/http/server.js`, all with environment variables only.

## Settings
| Field | Value |
|---|---|
| Framework | Express |
| Node.js | 20.x, 22.x or 24.x |
| Package manager | npm |
| Install command | `npm install` (also builds `dist/` automatically through `postinstall`) |
| Build command | `npm run build` (optional: `dist/` is already in the zip and is rebuilt on install) |
| Start command | `npm start` (runs `node dist/interfaces/http/server.js`) |
| Entry file | `dist/interfaces/http/server.js` (`index.js` and `server.js` at the root also work and build first if `dist/` is missing) |

The zip already contains a compiled `dist/`. If the host skips the build step the app still starts:
`index.js` compiles `src/` on the fly when `dist/` is missing.
Do **not** upload `node_modules` or `.env`.

## Environment variables (replace `.env` on the host)
```
NODE_ENV=production
DB_CLIENT=mysql2
DB_HOST=...            # same values as the ERP's .env
DB_PORT=3306
DB_DATABASE=...
DB_USERNAME=...
DB_PASSWORD=...
JWT_SECRET=...         # long random value, e.g. openssl rand -hex 32
ERP_PUBLIC_URL=https://<your ERP domain>   # used for logo / avatar links
ERP_ROOT_PATH=/home/<user>/domains/<erp domain>/public_html   # only needed for avatar uploads
ERP_API_URL=https://<your ERP domain>      # optional; defaults to ERP_PUBLIC_URL. Used by the "add new" (create) flows
ERP_MEDIA_TOKEN=...    # long random value; put the SAME value in the ERP's .env as MOBILE_MEDIA_TOKEN
# ERP_MEDIA_URL=https://<erp domain>   # optional, defaults to ERP_PUBLIC_URL
```
Photos (clients, notes, competitors, signatures, contacts, avatars, product exchanges) and stock-permit attachments (JPEG/PNG/PDF) are uploaded to the ERP through
`POST {ERP_MEDIA_URL}/api/mobile-media` and stored in its `public/` folders — this app keeps no files.
On the ERP: add `MOBILE_MEDIA_TOKEN=<same value>` to its `.env` (then `php artisan config:clear` if config is cached),
and run its migrations (`php artisan migrate`) — the stock section relies on the indexes added by
`2026_09_27_000001_add_stock_lookup_indexes`. Deploy the ERP's current `app/Http/Controllers/Api/MobileMediaController.php`
too: the sales exchanges upload into `uploads/product_exchanges`, which must be in its allowed folders.

`PORT` is provided by the host. `better-sqlite3` is optional (local development only) and is skipped if it cannot compile.

## Check
```
curl https://mobapi.fawtrasmart.com/api/v1/health
```
must return `{"success":true,...}`. A 403 HTML page means the domain is not attached to the Node.js app.

## Reading startup problems without the host log
If the app cannot start, it still answers HTTP with a JSON reason instead of a bare 503:
```
curl https://mobapi.fawtrasmart.com/api/v1/health
```
- `{"code":"INVALID_CONFIGURATION","details":{"JWT_SECRET":[...]}}` → the listed environment variables are missing or invalid (only names are shown, never values).
- `{"code":"STARTUP_FAILED","message":"Cannot find module ..."}` → dependencies were not installed; run `npm install` again.
- `{"success":true,...}` → the API is running.
A 503/403 HTML page (not JSON) means the request never reached this app: check the domain link and that the app is running.

## Checking the database connection
```
curl https://mobapi.fawtrasmart.com/api/v1/health/db
```
- `{"success":true,"data":{"database":"ok"}}` → connected to the ERP database.
- `{"code":"DATABASE_UNAVAILABLE","dbCode":"...","hint":"..."}` → the hint says what to fix
  (wrong `DB_USERNAME`/`DB_PASSWORD`, `DB_HOST` must be the real MySQL host instead of `localhost`,
  or Remote MySQL must allow this app). Credentials are never shown.

## Checking the connection to the ERP (add screens, photo uploads)
```
curl https://mobapi.fawtrasmart.com/api/v1/health/erp
```
- `{"success":true,"data":{"host":"<erp domain>","status":401,...}}` → the app server reaches the ERP (401 without a token is expected).
- `"code":"NOT_CONFIGURED"` → `ERP_PUBLIC_URL` is not set, so the app tries `http://127.0.0.1:8000`: set it and restart.
- `"code":"ENOTFOUND" | "ECONNREFUSED" | "ETIMEDOUT" | "CERT" | ...` → the `hint` says what to fix. Check that `host` is the ERP domain.

The app shows «تعذّر الاتصال بنظام الإدارة» whenever this check fails.

## Creating records (accounting "add" screens)
Read screens query the ERP database directly, but **creating** records goes through the ERP itself so every
accounting rule (numbering, journal lines, balances, periods, plan limits) stays in one place. This needs the
Laravel side deployed on the ERP domain:

- `app/Http/Middleware/MobileApiContext.php`
- `app/Http/Controllers/Mobile/MobileAccountingFormsController.php`
- `routes/mobile_api.php` (prefix `api/mobile`)
- the two-line changes in `app/Providers/RouteServiceProvider.php` and `bootstrap/app.php`

The API mints a short-lived Sanctum token (`erp-bridge`, ability `mobile:erp`) per user and calls
`{ERP_API_URL}/api/mobile/accounting/...` with it. If the ERP is not updated, the app's list screens keep working and
only saving a new record fails with a generic error.
