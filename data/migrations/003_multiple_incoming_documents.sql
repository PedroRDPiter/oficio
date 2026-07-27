alter table oficios_recibidos
add column if not exists documentos jsonb not null default '[]'::jsonb;

update oficios_recibidos
set documentos = jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
  'name', documento_nombre,
  'path', documento_url,
  'url', documento_url
)))
where jsonb_array_length(documentos) = 0
  and documento_url is not null;
