-- ---------------------------------------------------------------------------
--  Print the complete schema of this project as one script.
--  Read-only: it changes nothing. Run it in the SQL Editor, copy the single
--  result cell, and run that text on a fresh project.
-- ---------------------------------------------------------------------------
select string_agg(stmt, E'\n\n' order by ord) as schema_script from (
  select 1 as ord, string_agg(format('create type %I.%I as enum (%s);', n.nspname, t.typname,
           (select string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder)
              from pg_enum e where e.enumtypid = t.oid)), E'\n' order by t.typname) as stmt
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
   where t.typtype = 'e' and n.nspname = 'public'
  union all
  select 2, 'create schema if not exists private;'
  union all
  select 3, string_agg(format(E'create table %I.%I (%s%s);', n.nspname, c.relname,
      (select E'\n  ' || string_agg(format('%I %s%s%s', a.attname,
                format_type(a.atttypid, a.atttypmod),
                case when a.attnotnull then ' not null' else '' end,
                case when ad.adbin is not null then ' default ' || pg_get_expr(ad.adbin, ad.adrelid) else '' end),
              E',\n  ' order by a.attnum)
         from pg_attribute a left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
      coalesce((select E',\n  ' || string_agg(format('constraint %I %s', con.conname, pg_get_constraintdef(con.oid)), E',\n  ' order by con.contype desc, con.conname)
         from pg_constraint con where con.conrelid = c.oid and con.contype in ('p','u','c','f')), '')
    ), E'\n\n' order by c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'r' and n.nspname in ('public','private')
  union all
  select 4, string_agg(indexdef || ';', E'\n' order by tablename, indexname)
    from pg_indexes where schemaname in ('public','private')
      and indexname not in (select conname from pg_constraint where contype in ('p','u'))
  union all
  select 5, string_agg(pg_get_functiondef(p.oid) || ';', E'\n\n' order by n.nspname, p.proname)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public','private')
  union all
  select 6, string_agg(pg_get_triggerdef(t.oid) || ';', E'\n' order by t.tgname)
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where not t.tgisinternal and n.nspname in ('public','private','auth')
  union all
  select 7, string_agg(format('alter table %I.%I enable row level security;', n.nspname, c.relname), E'\n' order by c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind='r' and c.relrowsecurity and n.nspname in ('public','private')
  union all
  select 8, string_agg(format('create policy %I on %I.%I as %s for %s to %s%s%s;',
             policyname, schemaname, tablename, permissive, cmd, array_to_string(roles, ', '),
             case when qual is not null then ' using (' || qual || ')' else '' end,
             case when with_check is not null then ' with check (' || with_check || ')' else '' end),
           E'\n' order by tablename, policyname)
    from pg_policies where schemaname in ('public','private')
) s where stmt is not null;
