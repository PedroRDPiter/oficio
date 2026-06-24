alter table personal enable row level security;
alter table oficios_recibidos enable row level security;
alter table oficios_generados enable row level security;
alter table configuracion enable row level security;

drop policy if exists "personal_select" on personal;
drop policy if exists "personal_insert" on personal;
drop policy if exists "personal_update" on personal;
drop policy if exists "personal_delete" on personal;

create policy "personal_select"
on personal for select
using (true);

create policy "personal_insert"
on personal for insert
with check (true);

create policy "personal_update"
on personal for update
using (true)
with check (true);

create policy "personal_delete"
on personal for delete
using (true);

drop policy if exists "recibidos_select" on oficios_recibidos;
drop policy if exists "recibidos_insert" on oficios_recibidos;
drop policy if exists "recibidos_update" on oficios_recibidos;
drop policy if exists "recibidos_delete" on oficios_recibidos;

create policy "recibidos_select"
on oficios_recibidos for select
using (true);

create policy "recibidos_insert"
on oficios_recibidos for insert
with check (true);

create policy "recibidos_update"
on oficios_recibidos for update
using (true)
with check (true);

create policy "recibidos_delete"
on oficios_recibidos for delete
using (true);

drop policy if exists "generados_select" on oficios_generados;
drop policy if exists "generados_insert" on oficios_generados;
drop policy if exists "generados_update" on oficios_generados;
drop policy if exists "generados_delete" on oficios_generados;

create policy "generados_select"
on oficios_generados for select
using (true);

create policy "generados_insert"
on oficios_generados for insert
with check (true);

create policy "generados_update"
on oficios_generados for update
using (true)
with check (true);

create policy "generados_delete"
on oficios_generados for delete
using (true);

drop policy if exists "configuracion_select" on configuracion;
drop policy if exists "configuracion_update" on configuracion;

create policy "configuracion_select"
on configuracion for select
using (true);

create policy "configuracion_update"
on configuracion for update
using (true)
with check (true);

drop policy if exists "documentos_select" on storage.objects;
drop policy if exists "documentos_insert" on storage.objects;
drop policy if exists "documentos_update" on storage.objects;
drop policy if exists "documentos_delete" on storage.objects;

create policy "documentos_select"
on storage.objects for select
using (bucket_id = 'documentos');

create policy "documentos_insert"
on storage.objects for insert
with check (bucket_id = 'documentos');

create policy "documentos_update"
on storage.objects for update
using (bucket_id = 'documentos')
with check (bucket_id = 'documentos');

create policy "documentos_delete"
on storage.objects for delete
using (bucket_id = 'documentos');
