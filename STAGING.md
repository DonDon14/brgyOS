# BrgyOS Staging Workflow (Fast Dev)

## 1) Run local staging server
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
