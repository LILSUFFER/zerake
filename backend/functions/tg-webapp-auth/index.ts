// Supabase Edge Function: signs a Telegram Mini App user in.
// The Mini App sends Telegram's signed "initData"; we check the signature with the bot token,
// then return a one-time token that the browser exchanges for a normal Supabase session.
//
// Secret (set in Supabase -> Edge Functions -> Secrets, never in code): TELEGRAM_BOT_TOKEN
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED = ["https://zerake.com", "https://www.zerake.com"];
const MAX_AGE_SECONDS = 24 * 60 * 60;
const enc = new TextEncoder();

function cors(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED.includes(origin) ? origin : ALLOWED[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
}
const out = (b: unknown, s: number, h: Record<string, string>) => new Response(JSON.stringify(b), { status: s, headers: h });
const fail = (r: string, s: number, h: Record<string, string>, info: unknown = {}) => {
  console.error("tg-webapp-auth fail:", r, JSON.stringify(info));
  return out({ error: r }, s, h);
};

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const hmac = async (key: ArrayBuffer | Uint8Array, data: string) => {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
};
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req: Request) => {
  const h = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return out({ error: "method" }, 405, h);

  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!botToken) return fail("not configured", 500, h);

  let initData: string | undefined;
  try { initData = (await req.json())?.init_data; } catch { return fail("bad json", 400, h); }
  if (!initData || typeof initData !== "string") return fail("bad payload", 400, h);

  // Official check: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
  const params = new URLSearchParams(initData);
  const theirHash = params.get("hash");
  if (!theirHash) return fail("no hash", 401, h);
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  const ourHash = hex(await hmac(secret, dataCheckString));
  if (!safeEqual(ourHash, theirHash)) return fail("bad signature", 401, h);

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SECONDS) return fail("expired", 401, h);

  let user: Record<string, unknown>;
  try { user = JSON.parse(params.get("user") ?? ""); } catch { return fail("no user", 401, h); }
  const id = String(user.id ?? "");
  if (!/^[0-9]{1,20}$/.test(id)) return fail("bad user id", 401, h, { idType: typeof user.id });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  // Same address as the website's Telegram login, so it is one and the same account.
  const email = `tg${id}@users.zerake.invalid`;

  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: {
      provider: "telegram",
      telegram_id: id,
      username: user.username ?? null,
      first_name: user.first_name ?? null,
    },
  });
  if (created.error && !/already|registered|exists/i.test(created.error.message)) {
    console.error("createUser:", created.error.message);
  }

  const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !link?.properties?.hashed_token) return fail("link failed", 500, h, { message: error?.message });
  return out({ token_hash: link.properties.hashed_token }, 200, h);
});
