// Supabase Edge Function: verifies a Telegram Login id_token (OpenID Connect) and returns a
// one-time token the browser exchanges for a normal Supabase session.
//
// Setting (public): TELEGRAM_CLIENT_ID  - the bot's Client ID from BotFather
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
// The popup login flow does not use the Client Secret, so it is not needed here.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5.9.6";

const ALLOWED_ORIGINS = ["https://zerake.com", "https://www.zerake.com"];
const ISSUER = "https://oauth.telegram.org";
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers });

Deno.serve(async (req) => {
  const headers = { ...cors(req.headers.get("origin")), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ error: "method" }, 405, headers);

  const clientId = Deno.env.get("TELEGRAM_CLIENT_ID");
  if (!clientId) return json({ error: "not configured" }, 500, headers);

  let idToken: string | undefined;
  try { idToken = (await req.json())?.id_token; } catch { return json({ error: "bad json" }, 400, headers); }
  if (!idToken || typeof idToken !== "string") return json({ error: "bad payload" }, 400, headers);

  // Verify signature and expiry against Telegram's public keys, then check issuer and audience.
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(idToken, JWKS));
  } catch {
    return json({ error: "invalid token" }, 401, headers);
  }
  const aud = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud)];
  if (payload.iss !== ISSUER || !aud.includes(clientId)) return json({ error: "wrong issuer or audience" }, 401, headers);

  const tgId = String(payload.id ?? payload.sub ?? "");
  if (!/^[0-9]+$/.test(tgId)) return json({ error: "bad subject" }, 401, headers);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const email = `tg${tgId}@users.zerake.invalid`;

  // Create the user on first sign-in; ignore "already registered".
  await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: {
      provider: "telegram",
      telegram_id: tgId,
      username: payload.preferred_username ?? null,
      first_name: payload.given_name ?? payload.name ?? null,
    },
  });

  const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !link?.properties?.hashed_token) return json({ error: "link failed" }, 500, headers);
  return json({ token_hash: link.properties.hashed_token }, 200, headers);
});
