# PSLAW Site Update Portal

Single-app private security portal (Node/Express + SQLite) with one shared data model for all portals:

- Company Admin portal
- Employee portal
- Client portal (including token links)

All updates are company-scoped in one database, so each portal sees the same source of truth according to role permissions.

## Architecture

- One web app runtime: Node/Express
- One database: SQLite (`data/portal.db`)
- One unified roles model: company admin, manager, employee, client
- Optional base path support via `BASE_PATH` (example: `/node`)
- Installable as a PWA (no app store required)

## Main Capabilities

- Company profiles and site profiles per location
- Site details: name, address, manager representative
- Role-based access: company admin, manager/employee, client
- Employee onsite updates: site selector, date/time, location, notified staff, attachment upload (image/doc/text/video/audio/zip)
- Site issue reporting with priority workflow
- Client-approved visibility and direct messaging
- Invite link flow for client portal onboarding

## Stack

- Node.js 22 + Express
- SQLite
- EJS templates + static assets
- PWA manifest + service worker for installability

## Local Run

```bash
npm install
npm start
```

Open:

- `http://localhost:3000`

Optional base path mode:

```bash
BASE_PATH=/node npm start
```

Then use:

- `http://localhost:3000/node`

## Install Without App Store (PWA)

In Chrome/Edge/Safari (desktop or mobile):

1. Open the portal in browser.
2. Use browser "Install App" / "Add to Home Screen".
3. App runs in standalone mode with portal icon and cached shell assets.

```bash
npm install
npm start
```

## Docker Run (Node App)

1. Configure environment:

```bash
cp .env.example .env
```

2. Build and start:

```bash
docker compose up --build -d
```

3. Verify health:

```bash
curl http://localhost:3000/healthz
```

4. Access app:

- `http://localhost:3000/`

5. Logs:

```bash
docker compose logs -f node
```

6. Stop:

```bash
docker compose down
```

## Important Routes

- `/healthz`
- `/login`, `/register`
- `/admin`, `/employee`, `/client`
- `/updates/new` (quick add update)
- `/client/link/:token` (client direct portal)

## Data Cohesion Rules

- Every user belongs to one company.
- Every site belongs to one company.
- Every onsite update belongs to one site and one company scope.
- Admin, employee, and client portals read from the same `onsite_updates` table.
- Client visibility is enforced by update visibility + approved site access.
- Employee/admin portals display approved-site updates to keep operations synchronized.

## Notes

- Uploads persist in `uploads/` and database in `data/portal.db`.
- Use HTTPS in production for secure auth/session handling.
- Set strong `SESSION_SECRET` in environment.
