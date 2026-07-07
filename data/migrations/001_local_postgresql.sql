create extension if not exists pgcrypto;

create table if not exists personal (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  cargo text not null,
  correo text,
  telefono text,
  creado_en timestamptz not null default now()
);

create table if not exists oficios_recibidos (
  id uuid primary key default gen_random_uuid(),
  folio text not null,
  fecha_recepcion date not null,
  remitente text not null,
  asunto text not null,
  prioridad text not null default 'Normal',
  estado text not null default 'Pendiente de asignacion',
  observaciones text,
  documento_url text,
  documento_nombre text,
  respuesta text,
  fecha_respuesta date,
  respuesta_documento_url text,
  respuesta_documento_nombre text,
  asignado_a uuid references personal(id) on delete set null,
  fecha_limite date,
  instrucciones text,
  creado_en timestamptz not null default now()
);

create table if not exists oficios_generados (
  id uuid primary key default gen_random_uuid(),
  numero integer not null,
  numero_completo text not null,
  prefijo text not null default 'DPDU',
  fecha date not null,
  destinatario text not null,
  asunto text not null,
  elaboro uuid references personal(id) on delete set null,
  documento_url text,
  documento_nombre text,
  creado_en timestamptz not null default now()
);

create unique index if not exists oficios_generados_consecutivo_idx
on oficios_generados (prefijo, (extract(year from fecha)), numero);

create table if not exists configuracion (
  id text primary key,
  siguiente_numero integer not null default 1,
  correo_director text not null default 'dir.planeacionydu@gmail.com',
  telefono_director text,
  clave_borrado text not null default 'deshabilitada',
  notificar_correo boolean not null default true,
  notificar_whatsapp boolean not null default false,
  notificar_sistema boolean not null default true
);

create table if not exists agenda_registros (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  fecha date not null,
  hora time,
  participantes text[] not null default '{}',
  notas text,
  creado_en timestamptz not null default now()
);

insert into configuracion (
  id,
  siguiente_numero,
  correo_director,
  clave_borrado
)
values (
  'main',
  1,
  'dir.planeacionydu@gmail.com',
  'deshabilitada'
)
on conflict (id) do nothing;

create or replace function generar_oficio_local(
  p_prefijo text,
  p_fecha date,
  p_destinatario text,
  p_asunto text,
  p_elaboro uuid default null
)
returns oficios_generados
language plpgsql
as $$
declare
  v_numero integer;
  v_prefijo text;
  v_anio integer;
  v_row oficios_generados;
begin
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
