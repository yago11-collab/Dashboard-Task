-- Duración estimada de una tarea, en minutos. Se usa para sumar la carga del día.
alter table public.tasks add column if not exists estimate_min integer;
