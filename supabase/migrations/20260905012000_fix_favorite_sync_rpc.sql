-- COALESCE is a SQL expression and cannot be schema-qualified as a regular
-- pg_catalog function. Replace only the already-deployed Favorite Pull RPC.
create or replace function public.lingoflow_favorite_sync_pull(
  p_expected_owner_id uuid,
  p_after_cursor text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_after bigint := 0;
  v_head bigint := 0;
  v_changes jsonb := '[]'::jsonb;
begin
  if v_owner_id is null then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'changes', '[]'::jsonb,
      'nextCursor', null, 'reason', 'authentication-required'
    );
  end if;
  if p_expected_owner_id is distinct from v_owner_id then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'changes', '[]'::jsonb,
      'nextCursor', null, 'reason', 'owner-context-mismatch'
    );
  end if;
  if p_after_cursor is not null then
    if p_after_cursor !~ '^cursor:(0|[1-9][0-9]*)$' then
      return pg_catalog.jsonb_build_object(
        'status', 'rejected', 'changes', '[]'::jsonb,
        'nextCursor', null, 'reason', 'invalid-cursor'
      );
    end if;
    begin
      v_after := pg_catalog.substr(p_after_cursor, 8)::bigint;
    exception when numeric_value_out_of_range then
      return pg_catalog.jsonb_build_object(
        'status', 'rejected', 'changes', '[]'::jsonb,
        'nextCursor', null, 'reason', 'invalid-cursor'
      );
    end;
  end if;

  select coalesce(pg_catalog.max(cursor), 0::bigint)
    into v_head
    from public.favorite_sync_changes
    where owner_id = v_owner_id;
  if v_after > v_head then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'changes', '[]'::jsonb,
      'nextCursor', null, 'reason', 'cursor-out-of-range'
    );
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'cursor', 'cursor:' || c.cursor::text,
        'entityType', 'favorites',
        'entityId', c.entity_id,
        'scope', c.scope,
        'schemaVersion', c.schema_version,
        'revision', 'revision:' || c.revision::text,
        'operation', c.operation,
        'payload', c.payload
      ) order by c.cursor
    ),
    '[]'::jsonb
  ) into v_changes
  from public.favorite_sync_changes c
  where c.owner_id = v_owner_id and c.cursor > v_after;

  return pg_catalog.jsonb_build_object(
    'status', 'ready',
    'changes', v_changes,
    'nextCursor', 'cursor:' || v_head::text
  );
end;
$$;
