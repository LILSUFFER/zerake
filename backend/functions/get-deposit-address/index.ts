// Supabase Edge Function: gives the signed-in player their personal deposit address
// for a network (TRC20 or BEP20). Addresses are derived from PUBLIC keys (xpub) only,
// so this function never holds a key that can move money.
//
// Settings (Supabase -> Edge Functions -> Secrets): XPUB_TRON, XPUB_EVM  (public keys)
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { HDNodeWallet } from "https://esm.sh/ethers@6.13.4";

const ALLOWED = ["https://zerake.com", "https://www.zerake.com"];
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function cors(o: string | null): Record<string, string> {
  const a = o && ALLOWED.includes(o) ? o : ALLOWED[0];
  return {
    "Access-Control-Allow-Origin": a,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
}
const out = (b: unknown, s: number, h: Record<string, string>) => new Response(JSON.stringify(b), { status: s, headers: h });

function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b));
}
async function tronFromEvm(evm: string): Promise<string> {
  const body = new Uint8Array(21);
  body[0] = 0x41;
  for (let i = 0; i < 20; i++) body[i + 1] = parseInt(evm.slice(2 + i * 2, 4 + i * 2), 16);
  const check = (await sha256(await sha256(body))).subarray(0, 4);
  const full = new Uint8Array(25);
  full.set(body); full.set(check, 21);
  return base58(full);
}
async function deriveAddress(network: string, xpub: string, index: number): Promise<string> {
  // deno-lint-ignore no-explicit-any
  const node: any = HDNodeWallet.fromExtendedKey(xpub).deriveChild(0).deriveChild(index);
  return network === "TRC20" ? await tronFromEvm(node.address) : node.address;
}

Deno.serve(async (req: Request) => {
  const h = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return out({ error: "method" }, 405, h);

  const url = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return out({ error: "no session" }, 401, h);

  // Who is asking? Check the player's session token.
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false } });
  const { data: u, error: ue } = await asUser.auth.getUser(token);
  if (ue || !u?.user) return out({ error: "no session" }, 401, h);

  let network: string | undefined;
  try { network = (await req.json())?.network; } catch { return out({ error: "bad json" }, 400, h); }
  if (network !== "TRC20" && network !== "BEP20") return out({ error: "bad network" }, 400, h);

  // Take only the key itself, even if the saved value has extra text or line breaks around it.
  const rawKey = Deno.env.get(network === "TRC20" ? "XPUB_TRON" : "XPUB_EVM") ?? "";
  const xpub = rawKey.match(/xpub[1-9A-HJ-NP-Za-km-z]{100,}/)?.[0];
  if (!xpub) return out({ error: "not configured" }, 500, h);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const existing = await admin.from("deposit_addresses").select("address").eq("user_id", u.user.id).eq("network", network).maybeSingle();
  if (existing.data?.address) return out({ address: existing.data.address, network }, 200, h);

  const idx = await admin.rpc("next_deposit_index");
  if (idx.error || idx.data == null) { console.error("index:", idx.error?.message); return out({ error: "index failed" }, 500, h); }
  const index = Number(idx.data);

  let address: string;
  try { address = await deriveAddress(network, xpub, index); } catch (e) { console.error("derive:", String(e)); return out({ error: "derive failed" }, 500, h); }

  const ins = await admin.from("deposit_addresses").insert({ user_id: u.user.id, network, address, derivation_index: index });
  if (ins.error) {
    // Two requests at once: return the row that won.
    const again = await admin.from("deposit_addresses").select("address").eq("user_id", u.user.id).eq("network", network).maybeSingle();
    if (again.data?.address) return out({ address: again.data.address, network }, 200, h);
    console.error("insert:", ins.error.message);
    return out({ error: "save failed" }, 500, h);
  }
  return out({ address, network }, 200, h);
});
