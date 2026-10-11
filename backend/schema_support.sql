-- Zerake: the support chat. Players write to the support bot; their messages reach the staff in the staff bot,
-- and a staff reply (Telegram "Reply" on that message) goes back to the player through the support bot.
-- Server only: no row-level policies, only the edge functions (service role) read and write it.
create table if not exists public.support_messages (
  id            bigint generated always as identity primary key,
  player_tg     bigint not null,               -- the player's Telegram id (chat with the support bot)
  player_name   text,                          -- @username or first name, for the staff
  dir           text   not null check (dir in ('in', 'out')),   -- in = from the player, out = staff reply
  body          text,
  kind          text   not null default 'text',                 -- text, photo, document
  staff_tg      bigint,                        -- who got it (in) or who answered (out)
  staff_msg_id  bigint,                        -- the message id in that staff member's chat with the staff bot
  staff_name    text,
  created_at    timestamptz not null default now()
);
create index if not exists support_messages_staff on public.support_messages (staff_tg, staff_msg_id);
create index if not exists support_messages_player on public.support_messages (player_tg, created_at desc);
alter table public.support_messages enable row level security;
