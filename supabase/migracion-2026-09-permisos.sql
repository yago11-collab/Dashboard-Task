-- Las tareas y las listas solo las puede leer y cambiar el dueño (antes: cualquier usuario con sesión).
drop policy if exists "Ver tareas" on public.tasks;
drop policy if exists "tareas solo del dueño" on public.tasks;
create policy "tareas solo del dueño" on public.tasks
  for all to authenticated
  using (auth.uid() = '6f352f16-55e8-43f6-9e0a-8adf23e2c434') with check (auth.uid() = '6f352f16-55e8-43f6-9e0a-8adf23e2c434');

drop policy if exists "Ver columnas" on public.columns;
drop policy if exists "columnas solo del dueño" on public.columns;
create policy "columnas solo del dueño" on public.columns
  for all to authenticated
  using (auth.uid() = '6f352f16-55e8-43f6-9e0a-8adf23e2c434') with check (auth.uid() = '6f352f16-55e8-43f6-9e0a-8adf23e2c434');
