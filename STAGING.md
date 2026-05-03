# BrgyOS Staging Workflow (Fast Dev)

## 1) Run local staging server
Create local access keys in `.env` before opening the dashboards:
```bash
STAFF_DASHBOARD_KEY=choose-a-staff-key
OWNER_DASHBOARD_KEY=choose-an-owner-key
```

`ADMIN_DASHBOARD_KEY` is still accepted as a temporary fallback, but the pilot should use separate staff and owner keys.

For a live pilot, use Firestore so data survives deploys/restarts:
```bash
FIREBASE_PROJECT_ID=your-firebase-project-id
# or use FIREBASE_SERVICE_ACCOUNT_JSON for a service account JSON string
```

If Firebase is not configured, BrgyOS falls back to `data/requests.json` and now stores requests, barangays, staff, and token alerts there for small local pilots.

```bash
npm install
npm run staging
```

Default local URL:
- `http://localhost:1337`

## 2) Open local portals
- Owner portal: `http://localhost:1337/owner`
- Barangay portal: `http://localhost:1337/admin`

## 3) Test Messenger without Render redeploy
Expose localhost using a tunnel (example: Cloudflare tunnel):
```bash
cloudflared tunnel --url http://localhost:1337
```

Use the generated `https://...trycloudflare.com` URL as webhook callback:
- `https://<tunnel-domain>/webhook`

Then test Messenger flow live against your local code.

## 4) Deploy only when stable
After local testing passes:
1. Commit changes
2. Push to GitHub
3. Let Render auto-deploy

This avoids repeated deploy-debug cycles on Render.
