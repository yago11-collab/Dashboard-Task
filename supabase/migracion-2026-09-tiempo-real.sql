-- Publicar los cambios de estas tablas para que la app se entere al instante.
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.columns;
alter publication supabase_realtime add table public.ideas;
alter publication supabase_realtime add table public.batches;
alter publication supabase_realtime add table public.batch_items;
