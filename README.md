# Twelve Objects Inventory

The gallery's private inventory and invoicing at **admin.twelveobjects.com**: pieces, artists, agreement terms, invoices, payments owed, follow-ups, photos and files links. Sign-in is limited to @twelveobjects.com Google accounts. It installs on a phone as an app.

## How it is built

- `server.js`: Node and Express. Serves the app and a small API, and pushes live updates to open pages.
- `lib/db.js`: Postgres. Pieces, artists, invoices and settings are stored as JSON records, and photos are stored in the database too.
- Invoices: built from pieces in the inventory, downloaded as branded PDFs (jsPDF, served from `node_modules`). Marking an invoice sent puts its pieces on hold; paying it in full marks them sold and schedules consignment payouts 30 days out. The default sales tax rate is in Invoice settings.
- `lib/auth.js`: Google sign-in with a signed session cookie. Only `ALLOWED_DOMAIN` accounts, plus anyone listed in `ALLOWED_EMAILS`, get in.
- `public/`: the inventory screens (`index.html`, `app.js`), the connection layer (`shim.js`), the sign-in page, and the phone install files.
- `scripts/import.js`: loads records from a JSON file. On first boot, `data/initial.json` (the sample pieces, marked Sample, with a Remove samples button) is imported automatically if the database is empty.

## Going live on Render

1. **Google sign-in.** In Google Cloud Console, open APIs & Services, then Credentials, then Create OAuth client ID.
   - Type: Web application.
   - Authorized redirect URI: `https://admin.twelveobjects.com/auth/callback`.
   - On the OAuth consent screen, choose **Internal**, so only twelveobjects.com accounts can use it.
   - Keep the client ID and secret.
2. **Render.** Go to New, then Blueprint, then choose this repository. Render reads `render.yaml` and creates the database and the app. When asked, fill in:
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
   - `ALLOWED_EMAILS` (optional): outside people allowed in, separated by commas
3. **Domain.** Where twelveobjects.com's DNS is managed, add a **CNAME** record: name `admin`, value `twelve-objects-admin.onrender.com`. Render issues the HTTPS certificate on its own.
4. Open https://admin.twelveobjects.com and sign in.

On a phone, open the site, then tap Share and Add to Home Screen (iPhone) or Install app (Android).

## Local development

```
cp .env.example .env    # set DATABASE_URL; leave GOOGLE_CLIENT_ID empty to sign in as DEV_USER
npm install
npm run dev             # http://localhost:3000
npm test
```

## Backups

Render backs up paid Postgres databases automatically; see the database page in Render for restore options. A CSV of the inventory is available any time from Inventory, then Export CSV.
