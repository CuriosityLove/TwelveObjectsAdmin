# Twelve Objects Inventory

The gallery's private inventory at **admin.twelveobjects.com**: pieces, artists, agreement terms, payments owed, follow-ups, photos and files links. Sign-in is limited to @twelveobjects.com Google accounts. It installs on a phone as an app and emails a summary every Monday.

## How it is built

- `server.js`: Node and Express. Serves the app and a small API, and pushes live updates to open pages.
- `lib/db.js`: Postgres. Pieces and artists are stored as JSON records, and photos are stored in the database too.
- `lib/auth.js`: Google sign-in with a signed session cookie. Only `ALLOWED_DOMAIN` accounts, plus anyone listed in `ALLOWED_EMAILS`, get in.
- `public/`: the inventory screens (`index.html`, `app.js`), the connection layer (`shim.js`), the sign-in page, and the phone install files.
- `scripts/digest.js`: the Monday email. Lists payments, follow-ups and arrivals due within 14 days, pieces missing a signed agreement, and totals.
- `scripts/import.js`: loads records from a JSON file. On first boot, `data/initial.json` is imported automatically if the database is empty.

## Going live on Render

1. **Google sign-in.** In Google Cloud Console, open APIs & Services, then Credentials, then Create OAuth client ID.
   - Type: Web application.
   - Authorized redirect URI: `https://admin.twelveobjects.com/auth/callback`.
   - On the OAuth consent screen, choose **Internal**, so only twelveobjects.com accounts can use it.
   - Keep the client ID and secret.
2. **Email.** Sign in to Google as am@twelveobjects.com. Turn on 2-Step Verification, then create an App Password (Security, then App passwords). It is used as `SMTP_PASS`.
3. **Render.** Go to New, then Blueprint, then choose this repository. Render reads `render.yaml` and creates the database, the app and the Monday email job. When asked, fill in:
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
   - `SMTP_USER` (am@twelveobjects.com) and `SMTP_PASS`
   - `ALLOWED_EMAILS` (optional): outside people allowed in, separated by commas
4. **Domain.** Where twelveobjects.com's DNS is managed, add a **CNAME** record: name `admin`, value `twelve-objects-admin.onrender.com`. Render issues the HTTPS certificate on its own.
5. Open https://admin.twelveobjects.com and sign in.

On a phone, open the site, then tap Share and Add to Home Screen (iPhone) or Install app (Android).

## Local development

```
cp .env.example .env    # set DATABASE_URL; leave GOOGLE_CLIENT_ID empty to sign in as DEV_USER
npm install
npm run dev             # http://localhost:3000
npm test
npm run digest          # prints the Monday email instead of sending it when SMTP_HOST is unset
```

## Backups

Render backs up paid Postgres databases automatically; see the database page in Render for restore options. A CSV of the inventory is available any time from Inventory, then Export CSV.
