-- Add FavoriteLearningState to the existing account-global Favorite sync stream.

alter table public.favorite_sync_changes
  add column entity_type text not null default 'favorites';

alter table public.favorite_sync_changes
  add constraint favorite_sync_changes_entity_type_check
  check (entity_type in ('favorites', 'favoriteLearningStates'));

create table public.favorite_learning_sync_records (
  owner_id uuid not null references auth.users(id) on delete cascade,
  entity_id text not null,
  scope text not null check (scope = 'record'),
  schema_version text not null check (schema_version = '1'),
  revision bigint not null check (revision > 0),
  cursor bigint not null check (cursor > 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  server_updated_at timestamptz not null default statement_timestamp(),
  primary key (owner_id, entity_id, scope)
);

alter table public.favorite_learning_sync_records enable row level security;

create policy favorite_learning_sync_records_owner_only
  on public.favorite_learning_sync_records
  for all
  to authenticated
  using ((select auth.uid()) is not null and owner_id = (select auth.uid()))
  with check ((select auth.uid()) is not null and owner_id = (select auth.uid()));

revoke all on public.favorite_learning_sync_records from anon, authenticated;

create or replace function lingoflow_private.is_favorite_learning_payload(
  p_payload jsonb,
  p_entity_id text
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key_count integer;
  v_created_at text;
  v_updated_at text;
  v_deleted_at text;
begin
  if pg_catalog.jsonb_typeof(p_payload) <> 'object' or
      not (p_payload ?& array['favoriteId', 'mastered', 'createdAt', 'updatedAt', 'deletedAt']) then
    return false;
  end if;
  select pg_catalog.count(*) into v_key_count
    from pg_catalog.jsonb_object_keys(p_payload);
  if v_key_count <> 5 then
    return false;
  end if;
  if pg_catalog.jsonb_typeof(p_payload->'favoriteId') <> 'string' or
      p_payload->>'favoriteId' <> p_entity_id or
      p_entity_id is null or p_entity_id = '' or
      pg_catalog.btrim(p_entity_id) <> p_entity_id or
      pg_catalog.jsonb_typeof(p_payload->'mastered') <> 'boolean' or
      pg_catalog.jsonb_typeof(p_payload->'createdAt') <> 'string' or
      pg_catalog.jsonb_typeof(p_payload->'updatedAt') <> 'string' then
    return false;
  end if;

  v_created_at := p_payload->>'createdAt';
  v_updated_at := p_payload->>'updatedAt';
  if not lingoflow_private.is_canonical_utc_timestamp(v_created_at) or
      not lingoflow_private.is_canonical_utc_timestamp(v_updated_at) or
      v_created_at::pg_catalog.timestamptz > v_updated_at::pg_catalog.timestamptz then
    return false;
  end if;

  if pg_catalog.jsonb_typeof(p_payload->'deletedAt') = 'null' then
    v_deleted_at := null;
  elsif pg_catalog.jsonb_typeof(p_payload->'deletedAt') = 'string' then
    v_deleted_at := p_payload->>'deletedAt';
    if not lingoflow_private.is_canonical_utc_timestamp(v_deleted_at) or
        v_deleted_at::pg_catalog.timestamptz < v_created_at::pg_catalog.timestamptz or
        v_deleted_at::pg_catalog.timestamptz > v_updated_at::pg_catalog.timestamptz then
      return false;
    end if;
  else
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function lingoflow_private.is_favorite_learning_mutation(
  p_mutation jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key_count integer;
  v_field text;
begin
  if pg_catalog.jsonb_typeof(p_mutation) <> 'object' or
      not (p_mutation ?& array[
        'mutationId', 'entityType', 'entityId', 'scope', 'schemaVersion',
        'operation', 'baseRevision', 'observedCursor', 'payload'
      ]) then
    return false;
  end if;
  select pg_catalog.count(*) into v_key_count
    from pg_catalog.jsonb_object_keys(p_mutation);
  if v_key_count <> 9 then
    return false;
  end if;
  foreach v_field in array array[
    'mutationId', 'entityType', 'entityId', 'scope', 'schemaVersion', 'operation'
  ]
  loop
    if pg_catalog.jsonb_typeof(p_mutation->v_field) <> 'string' or
        p_mutation->>v_field = '' or
        pg_catalog.btrim(p_mutation->>v_field) <> p_mutation->>v_field then
      return false;
    end if;
  end loop;
  if p_mutation->>'entityType' <> 'favoriteLearningStates' or
      p_mutation->>'scope' <> 'record' or
      p_mutation->>'schemaVersion' <> '1' or
      p_mutation->>'operation' not in ('put', 'restore') then
    return false;
  end if;
  foreach v_field in array array['baseRevision', 'observedCursor']
  loop
    if pg_catalog.jsonb_typeof(p_mutation->v_field) <> 'null' and (
      pg_catalog.jsonb_typeof(p_mutation->v_field) <> 'string' or
      p_mutation->>v_field = '' or
      pg_catalog.btrim(p_mutation->>v_field) <> p_mutation->>v_field
    ) then
      return false;
    end if;
  end loop;
  return lingoflow_private.is_favorite_learning_payload(
    p_mutation->'payload',
    p_mutation->>'entityId'
  );
exception when others then
  return false;
end;
$$;

create or replace function public.lingoflow_favorite_learning_sync_push(
  p_expected_owner_id uuid,
  p_mutation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_mutation_id text;
  v_entity_id text;
  v_operation text;
  v_base_revision text;
  v_payload jsonb;
  v_current public.favorite_learning_sync_records%rowtype;
  v_favorite_payload jsonb;
  v_has_current boolean;
  v_receipt_request jsonb;
  v_receipt_result jsonb;
  v_has_receipt boolean;
  v_revision bigint;
  v_cursor bigint;
  v_result jsonb;
begin
  if v_owner_id is null then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'mutationId', null, 'entityType', null,
      'entityId', null, 'scope', null, 'reason', 'authentication-required'
    );
  end if;
  if not lingoflow_private.is_favorite_learning_mutation(p_mutation) then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'mutationId', null, 'entityType', null,
      'entityId', null, 'scope', null, 'reason', 'invalid-mutation'
    );
  end if;

  v_mutation_id := p_mutation->>'mutationId';
  v_entity_id := p_mutation->>'entityId';
  v_operation := p_mutation->>'operation';
  v_base_revision := p_mutation->>'baseRevision';
  v_payload := p_mutation->'payload';

  if p_expected_owner_id is distinct from v_owner_id then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'mutationId', v_mutation_id,
      'entityType', 'favoriteLearningStates', 'entityId', v_entity_id,
      'scope', 'record', 'reason', 'owner-context-mismatch'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.jsonb_build_array(v_owner_id::text, v_mutation_id)::text,
    0
  ));
  select mutation_request, mutation_result
    into v_receipt_request, v_receipt_result
    from public.favorite_sync_mutations
    where owner_id = v_owner_id and mutation_id = v_mutation_id;
  v_has_receipt := found;
  if v_has_receipt then
    if v_receipt_request = p_mutation then
      return v_receipt_result;
    end if;
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'mutationId', v_mutation_id,
      'entityType', 'favoriteLearningStates', 'entityId', v_entity_id,
      'scope', 'record', 'reason', 'idempotency-key-reused'
    );
  end if;

  select payload into v_favorite_payload
    from public.favorite_sync_records
    where owner_id = v_owner_id and entity_id = v_entity_id and scope = 'record';
  if not found then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'mutationId', v_mutation_id,
      'entityType', 'favoriteLearningStates', 'entityId', v_entity_id,
      'scope', 'record', 'reason', 'favorite-reference-missing'
    );
  end if;
  if pg_catalog.jsonb_typeof(v_favorite_payload->'deletedAt') <> 'null' then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'mutationId', v_mutation_id,
      'entityType', 'favoriteLearningStates', 'entityId', v_entity_id,
      'scope', 'record', 'reason', 'favorite-reference-deleted'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.jsonb_build_array(
      v_owner_id::text, 'favoriteLearningStates', v_entity_id
    )::text,
    1
  ));
  select * into v_current
    from public.favorite_learning_sync_records
    where owner_id = v_owner_id and entity_id = v_entity_id and scope = 'record'
    for update;
  v_has_current := found;

  if not v_has_current then
    if v_operation = 'restore' then
      v_result := pg_catalog.jsonb_build_object(
        'status', 'rejected', 'mutationId', v_mutation_id,
        'entityType', 'favoriteLearningStates', 'entityId', v_entity_id,
        'scope', 'record', 'reason', 'restore-target-not-tombstone'
      );
    elsif v_base_revision is not null then
      v_result := pg_catalog.jsonb_build_object(
        'status', 'rejected', 'mutationId', v_mutation_id,
        'entityType', 'favoriteLearningStates', 'entityId', v_entity_id,
        'scope', 'record', 'reason', 'base-revision-without-record'
      );
    else
      v_revision := 1;
      insert into public.favorite_sync_changes (
        owner_id, entity_type, entity_id, scope, schema_version, revision, operation, payload
      ) values (
        v_owner_id, 'favoriteLearningStates', v_entity_id, 'record', '1',
        v_revision, v_operation, v_payload
      ) returning cursor into v_cursor;
      insert into public.favorite_learning_sync_records (
        owner_id, entity_id, scope, schema_version, revision, cursor, payload
      ) values (
        v_owner_id, v_entity_id, 'record', '1', v_revision, v_cursor, v_payload
      );
      v_result := pg_catalog.jsonb_build_object(
        'status', 'applied', 'mutationId', v_mutation_id,
        'entityType', 'favoriteLearningStates', 'entityId', v_entity_id,
        'scope', 'record', 'schemaVersion', '1',
        'revision', 'revision:' || v_revision::text,
        'cursor', 'cursor:' || v_cursor::text
      );
    end if;
  elsif v_operation = 'restore' and pg_catalog.jsonb_typeof(v_current.payload->'deletedAt') = 'null' then
    v_result := pg_catalog.jsonb_build_object(
      'status', 'rejected', 'mutationId', v_mutation_id,
      'entityType', 'favoriteLearningStates', 'entityId', v_entity_id,
      'scope', 'record', 'reason', 'restore-target-not-tombstone'
    );
  elsif v_operation = 'restore' and pg_catalog.jsonb_typeof(v_payload->'deletedAt') <> 'null' then
    v_result := pg_catalog.jsonb_build_object(
      'status', 'rejected', 'mutationId', v_mutation_id,
      'entityType', 'favoriteLearningStates', 'entityId', v_entity_id,
      'scope', 'record', 'reason', 'restore-payload-must-be-active'
    );
  elsif v_current.payload = v_payload then
    v_result := pg_catalog.jsonb_build_object(
      'status', 'unchanged', 'mutationId', v_mutation_id,
      'entityType', 'favoriteLearningStates', 'entityId', v_entity_id,
      'scope', 'record', 'schemaVersion', '1',
      'revision', 'revision:' || v_current.revision::text,
      'cursor', 'cursor:' || v_current.cursor::text
    );
  elsif v_base_revision is distinct from 'revision:' || v_current.revision::text then
    v_result := pg_catalog.jsonb_build_object(
      'status', 'conflict', 'mutationId', v_mutation_id,
      'entityType', 'favoriteLearningStates', 'entityId', v_entity_id,
      'scope', 'record', 'schemaVersion', '1', 'reason', 'revision-mismatch',
      'currentRevision', 'revision:' || v_current.revision::text,
      'currentCursor', 'cursor:' || v_current.cursor::text,
      'currentPayload', v_current.payload
    );
  elsif v_operation = 'put' and
      pg_catalog.jsonb_typeof(v_current.payload->'deletedAt') <> 'null' and
      pg_catalog.jsonb_typeof(v_payload->'deletedAt') = 'null' then
    v_result := pg_catalog.jsonb_build_object(
      'status', 'rejected', 'mutationId', v_mutation_id,
      'entityType', 'favoriteLearningStates', 'entityId', v_entity_id,
      'scope', 'record', 'reason', 'explicit-restore-required'
    );
  else
    v_revision := v_current.revision + 1;
    insert into public.favorite_sync_changes (
      owner_id, entity_type, entity_id, scope, schema_version, revision, operation, payload
    ) values (
      v_owner_id, 'favoriteLearningStates', v_entity_id, 'record', '1',
      v_revision, v_operation, v_payload
    ) returning cursor into v_cursor;
    update public.favorite_learning_sync_records
      set revision = v_revision,
          cursor = v_cursor,
          payload = v_payload,
          server_updated_at = pg_catalog.statement_timestamp()
      where owner_id = v_owner_id and entity_id = v_entity_id and scope = 'record';
    v_result := pg_catalog.jsonb_build_object(
      'status', 'applied', 'mutationId', v_mutation_id,
      'entityType', 'favoriteLearningStates', 'entityId', v_entity_id,
      'scope', 'record', 'schemaVersion', '1',
      'revision', 'revision:' || v_revision::text,
      'cursor', 'cursor:' || v_cursor::text
    );
  end if;

  insert into public.favorite_sync_mutations (
    owner_id, mutation_id, mutation_request, mutation_result
  ) values (
    v_owner_id, v_mutation_id, p_mutation, v_result
  );
  return v_result;
end;
$$;

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
        'entityType', c.entity_type,
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

revoke all on function public.lingoflow_favorite_learning_sync_push(uuid, jsonb)
  from public, anon;
grant execute on function public.lingoflow_favorite_learning_sync_push(uuid, jsonb)
  to authenticated;
revoke all on function lingoflow_private.is_favorite_learning_payload(jsonb, text)
  from public;
revoke all on function lingoflow_private.is_favorite_learning_mutation(jsonb)
  from public;
