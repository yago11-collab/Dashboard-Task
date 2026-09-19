-- Ajustes de la app (por ejemplo, las direcciones privadas de los calendarios). Solo el dueño puede leerlos.
create table if not exists public.app_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

drop policy if exists "ajustes solo del dueño" on public.app_settings;
create policy "ajustes solo del dueño" on public.app_settings
  for all to authenticated
  using (auth.uid() = '6f352f16-55e8-43f6-9e0a-8adf23e2c434') with check (auth.uid() = '6f352f16-55e8-43f6-9e0a-8adf23e2c434');
