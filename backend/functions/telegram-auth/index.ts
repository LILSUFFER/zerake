// Supabase Edge Function: verifies a Telegram Login Widget payload and returns a
// one-time token the browser exchanges for a normal Supabase session.
//
// Secrets (set in Supabase, never in code): TELEGRAM_BOT_TOKEN
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://zerake.com", "https://www.zerake.com"];
const MAX_AGE_SECONDS = 24 * 60 * 60;
const enc = new TextEncoder();

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function telegramHash(data: Record<string, string>, botToken: string) {
  const check = Object.keys(data)
    .filter((k) => k !== "hash")
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join("\n");
  const secret = await crypto.subtle.digest("SHA-256", enc.encode(botToken));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(check)));
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  const headers = { ...cors(req.headers.get("origin")), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method" }), { status: 405, headers });

  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!botToken) return new Response(JSON.stringify({ error: "not configured" }), { status: 500, headers });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "bad json" }), { status: 400, headers }); }

  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) data[k] = String(v);

  if (!data.hash || !data.id || !data.auth_date) {
    return new Response(JSON.stringify({ error: "bad payload" }), { status: 400, headers });
  }
  const expected = await telegramHash(data, botToken);
  if (!safeEqual(expected, data.hash)) {
    return new Response(JSON.stringify({ error: "invalid signature" }), { status: 401, headers });
  }
  if (Date.now() / 1000 - Number(data.auth_date) > MAX_AGE_SECONDS) {
    return new Response(JSON.stringify({ error: "expired" }), { status: 401, headers });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const email = `tg${data.id}@users.zerake.invalid`;

  // Create the user on first sign-in; ignore "already registered".
  await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: {
      provider: "telegram",
      telegram_id: data.id,
      username: data.username ?? null,
      first_name: data.first_name ?? null,
    },
  });

  const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !link?.properties?.hashed_token) {
    return new Response(JSON.stringify({ error: "link failed" }), { status: 500, headers });
  }
  return new Response(JSON.stringify({ token_hash: link.properties.hashed_token }), { status: 200, headers });
});
