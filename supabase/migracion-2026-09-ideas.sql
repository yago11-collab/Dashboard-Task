-- Bandeja de ideas: entra por donde sea (app, Telegram, Claude) y se revisa en un sitio.
create table if not exists public.ideas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  text text not null,
  note text,
  source text,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.ideas enable row level security;

drop policy if exists "ideas solo del dueño" on public.ideas;
create policy "ideas solo del dueño" on public.ideas
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists ideas_archived_idx on public.ideas (archived_at, created_at desc);
