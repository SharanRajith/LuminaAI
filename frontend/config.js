// ─── Runtime configuration ───────────────────────────────────────────────────
// This file is committed with placeholder values so Netlify can deploy it.
// Fill in your real values below, then push to your deployment branch.
//
// SAFE to commit:  window.LUMINA_API_URL, SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey
// NEVER commit:    SUPABASE_SERVICE_ROLE_KEY (that belongs in backend/.env only)

// 1. Backend URL — your Railway / Render deployed URL.
//    Example: window.LUMINA_API_URL = 'https://lumina-backend.up.railway.app';
window.LUMINA_API_URL = 'https://lumina-ai-llbr.onrender.com';

// 2. Supabase — Dashboard > Project Settings > API > anon public key.
//    Leave as placeholders to disable auth/library (app still works without it).
window.SUPABASE_CONFIG = {
    url: 'https://stutxyiqausjicjmofsn.supabase.co',
    anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN0dXR4eWlxYXVzamljam1vZnNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3NjU2NTQsImV4cCI6MjA5NDM0MTY1NH0.TytRGnA-8uLDOXEatybhtsohzFtbAHJec1Ait7FX9no"

};
