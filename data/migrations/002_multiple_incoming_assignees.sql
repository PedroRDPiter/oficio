alter table oficios_recibidos
add column if not exists asignados uuid[] not null default '{}';

update oficios_recibidos
set asignados = array[asignado_a]
where asignado_a is not null
  and cardinality(asignados) = 0;
