// Supabase Edge Function: the Telegram bot's replies (webhook).
// Any message (/start included) gets two buttons that open the Mini App straight on the right screen:
//   "Buy chips"  -> https://zerake.com/app/?go=buy
//   "Sell chips" -> https://zerake.com/app/?go=sell
// Setup (once): open https://<project>.supabase.co/functions/v1/tg-bot?setup=1 — it points the bot's webhook here,
// sets the commands and the menu button. Telegram's requests are checked with a secret derived from the bot token.
// Secrets: TELEGRAM_BOT_TOKEN (already set).

const APP = "https://zerake.com/app/";

async function secretFor(token: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("zerake-webhook:" + token)));
  return Array.from(h.subarray(0, 24), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function tg(token: string, method: string, body: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return await r.json().catch(() => ({}));
}
function keyboard(ru: boolean) {
  return { inline_keyboard: [
    [{ text: ru ? "🟢 Купить фишки" : "🟢 Buy chips", web_app: { url: APP + "?go=buy" } },
     { text: ru ? "🔴 Продать фишки" : "🔴 Sell chips", web_app: { url: APP + "?go=sell" } }],
    [{ text: ru ? "📜 История операций" : "📜 History", web_app: { url: APP + "?go=history" } }],
  ] };
}

Deno.serve(async (req: Request) => {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return new Response("no token", { status: 500 });
  const url = new URL(req.url);

  // one-time setup: webhook, commands, menu button
  if (req.method === "GET" && url.searchParams.get("setup") === "1") {
    const hook = `https://${url.host}/functions/v1/tg-bot`;
    const a = await tg(token, "setWebhook", { url: hook, secret_token: await secretFor(token), allowed_updates: ["message"], drop_pending_updates: true });
    const b = await tg(token, "setMyCommands", { commands: [{ command: "start", description: "Buy or sell chips" }] });
    const c = await tg(token, "setMyCommands", { commands: [{ command: "start", description: "Купить или продать фишки" }], language_code: "ru" });
    const d = await tg(token, "setChatMenuButton", { menu_button: { type: "web_app", text: "Zerake", web_app: { url: APP } } });
    return new Response(JSON.stringify({ webhook: a.ok, commands: b.ok && c.ok, menu: d.ok, info: a.description ?? null }), { headers: { "Content-Type": "application/json" } });
  }

  if (req.method !== "POST") return new Response("ok");
  if (req.headers.get("x-telegram-bot-api-secret-token") !== await secretFor(token)) return new Response("forbidden", { status: 403 });
  const upd = await req.json().catch(() => ({}));
  const m = upd.message;
  if (!m?.chat?.id || m.chat.type !== "private") return new Response("ok");
  const ru = String(m.from?.language_code ?? "").startsWith("ru") || String(m.from?.language_code ?? "").startsWith("uk");
  const text = ru
    ? "Zerake — клуб без рейка.\n\nВыберите действие:"
    : "Zerake — the zero-rake club.\n\nWhat would you like to do?";
  await tg(token, "sendMessage", { chat_id: m.chat.id, text, reply_markup: keyboard(ru) });
  return new Response("ok");
});
