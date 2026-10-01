// Public settings for sign-in. These values are safe to publish:
// the Supabase anon key only works within the row-level security rules in backend/schema.sql.
window.ZERAKE = {
  supabaseUrl: "",      // e.g. https://abcdxyz.supabase.co
  supabaseAnonKey: "",  // Project Settings -> API -> anon public key
  telegramBotId: 0      // numeric bot id: the digits before the colon in the bot token, e.g. 123456789
};
