-- Papelera (borrado suave, se vacía sola a los 30 días) y recordatorios con hora.
alter table public.tasks add column if not exists deleted_at timestamptz;
alter table public.tasks add column if not exists remind_at timestamptz;
create index if not exists tasks_deleted_at_idx on public.tasks (deleted_at);
create index if not exists tasks_remind_at_idx on public.tasks (remind_at) where remind_at is not null;
