-- Ejecuta este archivo despues de crear usuarios en Supabase Auth.
-- Reemplaza las politicas abiertas de prueba por politicas con autenticacion.

create table if not exists perfiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  rol text not null check (rol in ('admin', 'director', 'ventanilla', 'responsable')),
  personal_id uuid references personal(id),
  creado_en timestamptz default now()
);

alter table personal
add column if not exists telefono text;

alter table oficios_recibidos
add column if not exists respuesta text,
add column if not exists fecha_respuesta date,
add column if not exists respuesta_documento_url text,
add column if not exists respuesta_documento_nombre text,
add column if not exists instrucciones text;

alter table configuracion
add column if not exists telefono_director text,
add column if not exists clave_borrado text,
add column if not exists notificar_correo boolean not null default true,
add column if not exists notificar_whatsapp boolean not null default false,
add column if not exists notificar_sistema boolean not null default true;

alter table perfiles enable row level security;
alter table personal enable row level security;
alter table oficios_recibidos enable row level security;
alter table oficios_generados enable row level security;
alter table configuracion enable row level security;

create or replace function public.mi_rol()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select rol from perfiles where user_id = auth.uid()
$$;

grant execute on function public.mi_rol() to authenticated;

create or replace function public.mi_personal_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select personal_id from perfiles where user_id = auth.uid()
$$;

grant execute on function public.mi_personal_id() to authenticated;

drop policy if exists "personal_select" on personal;
drop policy if exists "personal_insert" on personal;
drop policy if exists "personal_update" on personal;
drop policy if exists "personal_delete" on personal;
drop policy if exists "recibidos_select" on oficios_recibidos;
drop policy if exists "recibidos_insert" on oficios_recibidos;
drop policy if exists "recibidos_update" on oficios_recibidos;
drop policy if exists "recibidos_delete" on oficios_recibidos;
drop policy if exists "generados_select" on oficios_generados;
drop policy if exists "generados_insert" on oficios_generados;
drop policy if exists "generados_update" on oficios_generados;
drop policy if exists "generados_delete" on oficios_generados;
drop policy if exists "configuracion_select" on configuracion;
drop policy if exists "configuracion_update" on configuracion;
drop policy if exists "perfiles_select" on perfiles;
drop policy if exists "perfiles_insert" on perfiles;
drop policy if exists "perfiles_update" on perfiles;
drop policy if exists "perfiles_delete" on perfiles;

create policy "perfiles_select"
on perfiles for select
to authenticated
using (user_id = auth.uid() or public.mi_rol() = 'admin');

create policy "perfiles_insert"
on perfiles for insert
to authenticated
with check (public.mi_rol() = 'admin');

create policy "perfiles_update"
on perfiles for update
to authenticated
using (public.mi_rol() = 'admin')
with check (public.mi_rol() = 'admin');

create policy "perfiles_delete"
on perfiles for delete
to authenticated
using (public.mi_rol() = 'admin');

create policy "personal_select"
on personal for select
to authenticated
using (true);

create policy "personal_insert"
on personal for insert
to authenticated
with check (public.mi_rol() in ('admin', 'director'));

create policy "personal_update"
on personal for update
to authenticated
using (public.mi_rol() in ('admin', 'director'))
with check (public.mi_rol() in ('admin', 'director'));

create policy "personal_delete"
on personal for delete
to authenticated
using (public.mi_rol() = 'admin');

create policy "recibidos_select"
on oficios_recibidos for select
to authenticated
using (
  public.mi_rol() in ('admin', 'director', 'ventanilla')
  or asignado_a = public.mi_personal_id()
);

create policy "recibidos_insert"
on oficios_recibidos for insert
to authenticated
with check (public.mi_rol() in ('admin', 'director', 'ventanilla'));

create policy "recibidos_update"
on oficios_recibidos for update
to authenticated
using (
  public.mi_rol() in ('admin', 'director')
  or (public.mi_rol() = 'ventanilla' and asignado_a is null)
  or asignado_a = public.mi_personal_id()
)
with check (
  public.mi_rol() in ('admin', 'director')
  or (public.mi_rol() = 'ventanilla' and asignado_a is null)
  or asignado_a = public.mi_personal_id()
);

create policy "recibidos_delete"
on oficios_recibidos for delete
to authenticated
using (public.mi_rol() in ('admin', 'director'));

create policy "generados_select"
on oficios_generados for select
to authenticated
using (true);

create policy "generados_insert"
on oficios_generados for insert
to authenticated
with check (public.mi_rol() in ('admin', 'director', 'ventanilla'));

create policy "generados_update"
on oficios_generados for update
to authenticated
using (public.mi_rol() in ('admin', 'director'))
with check (public.mi_rol() in ('admin', 'director'));

create policy "generados_delete"
on oficios_generados for delete
to authenticated
using (public.mi_rol() = 'admin');

create policy "configuracion_select"
on configuracion for select
to authenticated
using (true);

create policy "configuracion_update"
on configuracion for update
to authenticated
using (public.mi_rol() in ('admin', 'director'))
with check (public.mi_rol() in ('admin', 'director'));

drop policy if exists "documentos_select" on storage.objects;
drop policy if exists "documentos_insert" on storage.objects;
drop policy if exists "documentos_update" on storage.objects;
drop policy if exists "documentos_delete" on storage.objects;

create policy "documentos_select"
on storage.objects for select
to authenticated
using (bucket_id = 'documentos');

create policy "documentos_insert"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'documentos'
  and public.mi_rol() in ('admin', 'director', 'ventanilla', 'responsable')
);

create policy "documentos_update"
on storage.objects for update
to authenticated
using (
  bucket_id = 'documentos'
  and public.mi_rol() in ('admin', 'director', 'ventanilla', 'responsable')
)
with check (
  bucket_id = 'documentos'
  and public.mi_rol() in ('admin', 'director', 'ventanilla', 'responsable')
);

create policy "documentos_delete"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'documentos'
  and public.mi_rol() in ('admin', 'director')
);

create or replace function public.generar_oficio(
  p_prefijo text,
  p_fecha date,
  p_destinatario text,
  p_asunto text,
  p_elaboro uuid
)
returns oficios_generados
language plpgsql
security definer
set search_path = public
as $$
declare
  v_numero integer;
  v_prefijo text;
  v_anio integer;
  v_row oficios_generados;
begin
  if public.mi_rol() not in ('admin', 'director', 'ventanilla') then
    raise exception 'No autorizado';
  end if;

  v_prefijo := upper(coalesce(nullif(trim(p_prefijo), ''), 'DPDU'));
  v_anio := extract(year from p_fecha)::int;

  perform pg_advisory_xact_lock(hashtext(v_prefijo || ':' || v_anio::text));

  select coalesce(max(numero), 0) + 1
  into v_numero
  from oficios_generados
  where prefijo = v_prefijo
    and extract(year from fecha)::int = v_anio;

  insert into oficios_generados (
    numero,
    numero_completo,
    prefijo,
    fecha,
    destinatario,
    asunto,
    elaboro
  )
  values (
    v_numero,
    v_prefijo || '-' || lpad(v_numero::text, 3, '0') || '/' || v_anio,
    v_prefijo,
    p_fecha,
    p_destinatario,
    p_asunto,
    p_elaboro
  )
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.generar_oficio(text, date, text, text, uuid) to authenticated;
