# Deploying FinGuard AI on Render

The repo is Render-ready: it binds to `PORT`, has a `/api/health` check, and
`render.yaml` provisions a web service + a persistent disk for user data.

## One-time deploy
1. Push the latest code to GitHub (`Topsy-yy/financializer`).
2. In Render: **New → Blueprint**, select this repo. Render reads `render.yaml`
   and creates the **finguard-ai** web service with a 1 GB disk at `/var/data`.
3. When prompted, fill the `sync:false` env vars:
   - `APP_BASE_URL` — your live URL. Use the Render URL first
     (`https://finguard-ai.onrender.com`), switch to `https://yourdomain.xyz`
     once the custom domain is attached.
   - `NVIDIA_API_KEY` — free-tier default AI.
   - `MISTRAL_APP_KEY` — managed Pro AI (the key you fund).
   - `ZOHO_OAUTH_CLIENT_ID` / `ZOHO_OAUTH_CLIENT_SECRET` (optional, for Zoho sync).
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (optional, for Google sign-in).
   `SESSION_SECRET` is generated automatically; `REPORTS_DIR`, `NODE_VERSION`,
   and `MOCK_REQUIRED_INTEGRATIONS` are preset.
4. Click **Apply / Create**. First build runs `npm install` (compiles contracts
   via postinstall) and starts the server. Health check hits `/api/health`.

## After it's live
- Update OAuth **redirect URIs** to the live domain in the Zoho and Google
  developer consoles (the app derives them from `APP_BASE_URL`):
  `…/api/oauth/zoho/callback` and `…/api/auth/google/callback`.
- Custom domain: **Settings → Custom Domains → add `yourdomain.xyz`**, then add
  the CNAME/A record Render shows at your registrar. SSL is automatic. Then set
  `APP_BASE_URL=https://yourdomain.xyz` and redeploy.

## Notes / caveats
- **Plan:** `starter` (~$7/mo) is required for the persistent disk. The `free`
  plan has **no disk** (data resets on redeploy) and sleeps when idle — fine for
  a demo only.
- **Single instance:** file storage + in-memory sessions are per-instance. Don't
  scale to multiple instances without moving storage to a database.
- **Backups:** the `/var/data` disk holds all user data — enable Render disk
  snapshots or back it up.
