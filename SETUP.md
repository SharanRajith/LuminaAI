# Lumina AI — Deployment Guide

---

## Prerequisites

- A [Supabase](https://supabase.com) project (free tier is fine)
- A backend host — [Railway](https://railway.app/) or [Render](https://render.com/)
- A frontend host — [Netlify](https://netlify.com/) or [Vercel](https://vercel.com/)
- Ollama running somewhere accessible from your backend (see Step 3)

---

## Step 1 — Supabase Setup

1. Create a new Supabase project.
2. Go to **Settings › API** and note your:
   - **Project URL** (looks like `https://xxxx.supabase.co`)
   - **anon public** key (used in the frontend)
   - **service_role** key (used in the backend — keep this secret)
3. Open the **SQL Editor** and run the following to create the creations table:

```sql
create table creations (
  id         uuid        default uuid_generate_v4() primary key,
  user_id    uuid        references auth.users not null,
  type       text        not null,
  prompt     text        not null,
  created_at timestamptz default now() not null
);

-- Only the owner can read/delete their own rows
alter table creations enable row level security;

create policy "Users manage their own creations"
  on creations for all
  using (auth.uid() = user_id);
```

4. (Optional) Enable Google / GitHub OAuth under **Authentication › Providers**.

---

## Step 2 — Configure the Frontend

Open `frontend/config.js` and fill in your values:

```js
window.LUMINA_API_URL = 'https://YOUR_BACKEND_URL_HERE'; // set after Step 3

window.SUPABASE_CONFIG = {
    url:     'https://xxxx.supabase.co',
    anonKey: 'your-anon-public-key',
};
```

> **Do not commit real keys.** `config.js` is listed in `.gitignore`.
> For Netlify, you can also use the **Snippet Injection** feature (Site Settings › Build & Deploy › Post Processing) to inject a `<script>` that sets these variables without touching the file.

---

## Step 3 — Deploy the Backend

### Option A: Railway / Render (recommended)

1. Push this repository to GitHub.
2. Create a new **Web Service** on Railway or Render, linked to your repo.
3. Set the following **environment variables** in the platform dashboard:

   | Variable | Value |
   |---|---|
   | `SUPABASE_URL` | Your Supabase Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase **service_role** key |
   | `OLLAMA_URL` | URL of your Ollama instance (see below) |
   | `CORS_ORIGIN` | Your Netlify URL, e.g. `https://lumina-ai.netlify.app` |

4. The `Procfile` at the root handles the start command automatically.
5. Copy the public backend URL (e.g. `https://lumina-backend.up.railway.app`) and paste it into `frontend/config.js` as `window.LUMINA_API_URL`.

### Option B: Docker (self-hosted / VPS)

1. Copy `.env.example` to `backend/.env` and fill in your values.
2. Run:
   ```bash
   docker compose up -d
   ```
   This starts Ollama, pulls the llama3 model automatically, and starts the backend.
3. The backend is available at `http://your-server-ip:8000`.

### Ollama

The backend requires a running Ollama instance with the `llama3` model pulled.
- **Self-hosted**: `ollama pull llama3` on the same machine, then set `OLLAMA_URL=http://localhost:11434/api/generate`.
- **Docker**: handled automatically by `docker compose up`.
- **Railway/Render**: Ollama can't run inside most serverless platforms — host it on a separate VPS or a GPU-enabled machine and point `OLLAMA_URL` at it.

---

## Step 4 — Deploy the Frontend

1. Make sure `frontend/config.js` has your real backend URL and Supabase keys.
2. Push to GitHub.
3. Connect your repo to Netlify. It auto-detects `netlify.toml` and deploys the `frontend/` directory.
4. Your site is live at your Netlify URL.
5. Update `CORS_ORIGIN` in your backend's environment variables to match this URL.

---

## Step 5 — Verify

- Visit your Netlify URL — the home page should load.
- Click **Create**, enter a topic, and generate a presentation.
- Check your backend logs if anything fails — every error is now logged with context.

---

## Environment Variable Reference

### Backend (`backend/.env`)

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | No | Enables auth and library features |
| `SUPABASE_SERVICE_ROLE_KEY` | No | Supabase **service_role** key (not the anon key) |
| `OLLAMA_URL` | Yes | Full URL to the Ollama generate endpoint |
| `CORS_ORIGIN` | Yes (prod) | Your frontend URL; defaults to `*` (warns on startup) |

### Frontend (`frontend/config.js`)

| Variable | Description |
|---|---|
| `window.LUMINA_API_URL` | Deployed backend URL |
| `window.SUPABASE_CONFIG.url` | Supabase Project URL |
| `window.SUPABASE_CONFIG.anonKey` | Supabase anon public key |
