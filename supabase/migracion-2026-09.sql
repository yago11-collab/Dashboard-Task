-- Migración de septiembre de 2026: fechas, repetición y lotes de contenido.
-- Se ejecuta una sola vez en Supabase > SQL Editor. Es segura de repetir.

-- 1. Campos nuevos en las tareas
alter table public.tasks add column if not exists scheduled_on date;
alter table public.tasks add column if not exists deadline_on date;
alter table public.tasks add column if not exists recurrence text;
alter table public.tasks add column if not exists last_done_on date;
alter table public.tasks add column if not exists completed_at timestamptz;
alter table public.tasks add column if not exists created_at timestamptz default now();

-- 2. Lotes de contenido
create table if not exists public.batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  stages jsonb not null default '[]'::jsonb,
  stage_dates jsonb not null default '{}'::jsonb,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.batch_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  batch_id uuid not null references public.batches (id) on delete cascade,
  title text not null,
  stage integer not null default 0,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.batches enable row level security;
alter table public.batch_items enable row level security;

drop policy if exists "batches del propio usuario" on public.batches;
create policy "batches del propio usuario" on public.batches
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "batch_items del propio usuario" on public.batch_items;
create policy "batch_items del propio usuario" on public.batch_items
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
