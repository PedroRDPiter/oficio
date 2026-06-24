create table personal (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  cargo text not null,
  correo text,
  creado_en timestamptz default now()
);

create table oficios_recibidos (
  id uuid primary key default gen_random_uuid(),
  folio text not null,
  fecha_recepcion date not null,
  remitente text not null,
  asunto text not null,
  prioridad text default 'Normal',
  estado text default 'Pendiente de asignacion',
  observaciones text,
  documento_url text,
  documento_nombre text,
  respuesta text,
  fecha_respuesta date,
  respuesta_documento_url text,
  respuesta_documento_nombre text,
  asignado_a uuid references personal(id),
  fecha_limite date,
  instrucciones text,
  creado_en timestamptz default now()
);

create table oficios_generados (
  id uuid primary key default gen_random_uuid(),
  numero integer not null,
  numero_completo text not null,
  prefijo text not null default 'DPDU',
  fecha date not null,
  destinatario text not null,
  asunto text not null,
  elaboro uuid references personal(id),
  creado_en timestamptz default now()
);

create table configuracion (
  id text primary key,
  siguiente_numero integer not null default 1,
  correo_director text not null default 'director@municipio.gob.mx'
);

insert into configuracion (id, siguiente_numero, correo_director)
values ('main', 1, 'director@municipio.gob.mx')
on conflict (id) do nothing;


