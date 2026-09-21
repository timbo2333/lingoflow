-- V0.8A-3: independent Article protocol. No product runtime is enabled by this migration.
-- A historical snapshot is kept per change so a lagging device never observes a
-- later version in place of an earlier cursor. Receipts intentionally omit content.

create or replace function lingoflow_private.is_article_client_timestamp(p_value text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_value is null or p_value !~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
    return false;
  end if;
  perform p_value::pg_catalog.timestamptz;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function lingoflow_private.is_article_projection(
  p_projection jsonb,
  p_article_id text
)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_key text;
begin
  if pg_catalog.jsonb_typeof(p_projection) <> 'object' or
      not (p_projection ?& array[
        'id', 'title', 'content', 'sourceType', 'createdAt', 'updatedAt', 'deletedAt'
      ]) or p_article_id is null or p_article_id = '' or
      pg_catalog.btrim(p_article_id) <> p_article_id then
    return false;
  end if;
  for v_key in select k from pg_catalog.jsonb_object_keys(p_projection) as keys(k)
  loop
    if v_key not in (
      'id', 'title', 'content', 'sourceType', 'sourceId', 'sourceTitle',
      'sourceAttribution', 'createdAt', 'updatedAt', 'deletedAt'
    ) then
      return false;
    end if;
  end loop;
  if pg_catalog.jsonb_typeof(p_projection->'id') <> 'string' or
      p_projection->>'id' <> p_article_id or
      pg_catalog.jsonb_typeof(p_projection->'title') <> 'string' or
      pg_catalog.btrim(p_projection->>'title') = '' or
      pg_catalog.jsonb_typeof(p_projection->'content') <> 'string' or
      pg_catalog.btrim(p_projection->>'content') = '' or
      pg_catalog.jsonb_typeof(p_projection->'sourceType') <> 'string' or
      p_projection->>'sourceType' not in ('paste', 'txt', 'library') or
      pg_catalog.jsonb_typeof(p_projection->'createdAt') <> 'string' or
      pg_catalog.jsonb_typeof(p_projection->'updatedAt') <> 'string' or
      not lingoflow_private.is_article_client_timestamp(p_projection->>'createdAt') or
      not lingoflow_private.is_article_client_timestamp(p_projection->>'updatedAt') then
    return false;
  end if;
  if p_projection->>'sourceType' = 'library' then
    if pg_catalog.jsonb_typeof(p_projection->'sourceId') <> 'string' or
        pg_catalog.btrim(p_projection->>'sourceId') = '' then
      return false;
    end if;
  elsif p_projection ? 'sourceId' then
    return false;
  end if;
  foreach v_key in array array['sourceId', 'sourceTitle', 'sourceAttribution']
  loop
    if p_projection ? v_key and (
      pg_catalog.jsonb_typeof(p_projection->v_key) <> 'string' or
      pg_catalog.btrim(p_projection->>v_key) = ''
    ) then
      return false;
    end if;
  end loop;
  if pg_catalog.jsonb_typeof(p_projection->'deletedAt') = 'null' then
    return true;
  end if;
  return pg_catalog.jsonb_typeof(p_projection->'deletedAt') = 'string' and
    lingoflow_private.is_article_client_timestamp(p_projection->>'deletedAt');
exception when others then
  return false;
end;
$$;

create table public.article_sync_records (
  owner_id uuid not null references auth.users(id) on delete cascade,
  article_id text not null,
  title text not null,
  content text not null,
  source_type text not null check (source_type in ('paste', 'txt', 'library')),
  source_id text,
  source_title text,
  source_attribution text,
  created_at_client text not null,
  updated_at_client text not null,
  deleted_at_client text,
  revision bigint not null check (revision > 0),
  cursor bigint not null check (cursor > 0),
  created_at_server timestamptz not null default pg_catalog.statement_timestamp(),
  updated_at_server timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (owner_id, article_id),
  check (source_type <> 'library' or source_id is not null)
);

create table public.article_sync_changes (
  cursor bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  article_id text not null,
  operation text not null check (operation in ('put', 'delete', 'restore')),
  revision bigint not null check (revision > 0),
  projection jsonb not null,
  created_at_server timestamptz not null default pg_catalog.statement_timestamp(),
  check (lingoflow_private.is_article_projection(projection, article_id))
);

create index article_sync_changes_owner_cursor_idx
  on public.article_sync_changes (owner_id, cursor);

create table public.article_sync_mutations (
  owner_id uuid not null references auth.users(id) on delete cascade,
  mutation_id text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  article_id text not null,
  operation text not null check (operation in ('put', 'delete', 'restore')),
  resulting_revision bigint,
  resulting_cursor bigint,
  mutation_result jsonb not null check (pg_catalog.jsonb_typeof(mutation_result) = 'object'),
  created_at_server timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (owner_id, mutation_id)
);

-- Kept separate from the Product Article record and from direct Data API access.
alter table public.article_sync_records enable row level security;
alter table public.article_sync_changes enable row level security;
alter table public.article_sync_mutations enable row level security;

create policy article_sync_records_owner_only on public.article_sync_records
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy article_sync_changes_owner_only on public.article_sync_changes
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy article_sync_mutations_owner_only on public.article_sync_mutations
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

revoke all on public.article_sync_records from public, anon, authenticated;
revoke all on public.article_sync_changes from public, anon, authenticated;
revoke all on public.article_sync_mutations from public, anon, authenticated;
revoke all on sequence public.article_sync_changes_cursor_seq from public, anon, authenticated;

create or replace function lingoflow_private.article_record_projection(
  p_record public.article_sync_records
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_record.article_id,
    'title', p_record.title,
    'content', p_record.content,
    'sourceType', p_record.source_type,
    'createdAt', p_record.created_at_client,
    'updatedAt', p_record.updated_at_client,
    'deletedAt', p_record.deleted_at_client
  ) || case when p_record.source_id is null then '{}'::jsonb
       else pg_catalog.jsonb_build_object('sourceId', p_record.source_id) end
    || case when p_record.source_title is null then '{}'::jsonb
       else pg_catalog.jsonb_build_object('sourceTitle', p_record.source_title) end
    || case when p_record.source_attribution is null then '{}'::jsonb
       else pg_catalog.jsonb_build_object('sourceAttribution', p_record.source_attribution) end
$$;

create or replace function lingoflow_private.is_article_mutation(p_mutation jsonb)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_key text;
begin
  if pg_catalog.jsonb_typeof(p_mutation) <> 'object' or
      not (p_mutation ?& array[
        'mutationId', 'articleId', 'operation', 'baseRevision', 'projection'
      ]) then
    return false;
  end if;
  for v_key in select k from pg_catalog.jsonb_object_keys(p_mutation) as keys(k)
  loop
    if v_key not in ('mutationId', 'articleId', 'operation', 'baseRevision', 'projection') then
      return false;
    end if;
  end loop;
  if pg_catalog.jsonb_typeof(p_mutation->'mutationId') <> 'string' or
      p_mutation->>'mutationId' = '' or
      pg_catalog.btrim(p_mutation->>'mutationId') <> p_mutation->>'mutationId' or
      pg_catalog.jsonb_typeof(p_mutation->'articleId') <> 'string' or
      p_mutation->>'articleId' = '' or
      pg_catalog.btrim(p_mutation->>'articleId') <> p_mutation->>'articleId' or
      pg_catalog.jsonb_typeof(p_mutation->'operation') <> 'string' or
      p_mutation->>'operation' not in ('put', 'delete', 'restore') or
      not lingoflow_private.is_article_projection(
        p_mutation->'projection', p_mutation->>'articleId'
      ) then
    return false;
  end if;
  if pg_catalog.jsonb_typeof(p_mutation->'baseRevision') <> 'null' and (
    pg_catalog.jsonb_typeof(p_mutation->'baseRevision') <> 'string' or
    p_mutation->>'baseRevision' !~ '^revision:[1-9][0-9]*$'
  ) then
    return false;
  end if;
  if p_mutation->>'operation' = 'delete' then
    return pg_catalog.jsonb_typeof(p_mutation->'projection'->'deletedAt') = 'string';
  end if;
  return pg_catalog.jsonb_typeof(p_mutation->'projection'->'deletedAt') = 'null';
exception when others then
  return false;
end;
$$;

create or replace function public.lingoflow_article_sync_push(
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
  v_article_id text;
  v_operation text;
  v_base_revision text;
  v_projection jsonb;
  v_request_hash text;
  v_receipt public.article_sync_mutations%rowtype;
  v_current public.article_sync_records%rowtype;
  v_has_current boolean;
  v_revision bigint;
  v_cursor bigint;
  v_result jsonb;
begin
  if v_owner_id is null then
    return pg_catalog.jsonb_build_object('status', 'rejected', 'reason', 'authentication-required');
  end if;
  if p_expected_owner_id is distinct from v_owner_id then
    return pg_catalog.jsonb_build_object('status', 'rejected', 'reason', 'owner-context-mismatch');
  end if;
  if not lingoflow_private.is_article_mutation(p_mutation) then
    return pg_catalog.jsonb_build_object('status', 'rejected', 'reason', 'invalid-mutation');
  end if;

  v_mutation_id := p_mutation->>'mutationId';
  v_article_id := p_mutation->>'articleId';
  v_operation := p_mutation->>'operation';
  v_base_revision := p_mutation->>'baseRevision';
  v_projection := p_mutation->'projection';
  v_request_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_mutation::text, 'UTF8')), 'hex'
  );

  -- Serializes commits for this owner. A global identity sequence alone does
  -- not guarantee that concurrently committed cursors become visible in order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner_id::text, 210921)
  );
  select * into v_receipt from public.article_sync_mutations
    where owner_id = v_owner_id and mutation_id = v_mutation_id;
  if found then
    if v_receipt.request_hash = v_request_hash then
      return v_receipt.mutation_result;
    end if;
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'reason', 'idempotency-key-reused',
      'mutationId', v_mutation_id, 'articleId', v_article_id
    );
  end if;

  select * into v_current from public.article_sync_records
    where owner_id = v_owner_id and article_id = v_article_id for update;
  v_has_current := found;

  if not v_has_current then
    if v_operation <> 'put' then
      v_result := pg_catalog.jsonb_build_object(
        'status', 'rejected', 'reason', 'article-not-found',
        'mutationId', v_mutation_id, 'articleId', v_article_id
      );
    elsif v_base_revision is not null then
      v_result := pg_catalog.jsonb_build_object(
        'status', 'conflict', 'reason', 'revision-mismatch',
        'mutationId', v_mutation_id, 'articleId', v_article_id,
        'currentRevision', null, 'currentCursor', null,
        'currentLifecycle', 'missing'
      );
    else
      v_revision := 1;
    end if;
  elsif v_base_revision is distinct from 'revision:' || v_current.revision::text then
    v_result := pg_catalog.jsonb_build_object(
      'status', 'conflict', 'reason', 'revision-mismatch',
      'mutationId', v_mutation_id, 'articleId', v_article_id,
      'currentRevision', 'revision:' || v_current.revision::text,
      'currentCursor', 'cursor:' || v_current.cursor::text,
      'currentLifecycle', case when v_current.deleted_at_client is null
        then 'active' else 'deleted' end,
      'snapshotRpc', 'lingoflow_article_sync_snapshot'
    );
  elsif v_operation = 'put' and v_current.deleted_at_client is not null then
    v_result := pg_catalog.jsonb_build_object(
      'status', 'rejected', 'reason', 'explicit-restore-required',
      'mutationId', v_mutation_id, 'articleId', v_article_id,
      'currentRevision', 'revision:' || v_current.revision::text,
      'currentLifecycle', 'deleted'
    );
  elsif v_operation = 'delete' and v_current.deleted_at_client is not null then
    v_result := pg_catalog.jsonb_build_object(
      'status', 'rejected', 'reason', 'already-deleted',
      'mutationId', v_mutation_id, 'articleId', v_article_id,
      'currentRevision', 'revision:' || v_current.revision::text,
      'currentLifecycle', 'deleted'
    );
  elsif v_operation = 'restore' and v_current.deleted_at_client is null then
    v_result := pg_catalog.jsonb_build_object(
      'status', 'rejected', 'reason', 'restore-target-not-tombstone',
      'mutationId', v_mutation_id, 'articleId', v_article_id,
      'currentRevision', 'revision:' || v_current.revision::text,
      'currentLifecycle', 'active'
    );
  elsif v_operation = 'put' and
      lingoflow_private.article_record_projection(v_current) = v_projection then
    v_revision := v_current.revision;
    v_cursor := v_current.cursor;
    v_result := pg_catalog.jsonb_build_object(
      'status', 'unchanged', 'mutationId', v_mutation_id,
      'articleId', v_article_id, 'operation', v_operation,
      'revision', 'revision:' || v_revision::text,
      'cursor', 'cursor:' || v_cursor::text
    );
  else
    v_revision := v_current.revision + 1;
  end if;

  if v_result is null then
    insert into public.article_sync_changes (
      owner_id, article_id, operation, revision, projection
    ) values (
      v_owner_id, v_article_id, v_operation, v_revision, v_projection
    ) returning cursor into v_cursor;

    if v_has_current then
      update public.article_sync_records set
        title = v_projection->>'title', content = v_projection->>'content',
        source_type = v_projection->>'sourceType', source_id = v_projection->>'sourceId',
        source_title = v_projection->>'sourceTitle',
        source_attribution = v_projection->>'sourceAttribution',
        created_at_client = v_projection->>'createdAt',
        updated_at_client = v_projection->>'updatedAt',
        deleted_at_client = v_projection->>'deletedAt',
        revision = v_revision, cursor = v_cursor,
        updated_at_server = pg_catalog.statement_timestamp()
      where owner_id = v_owner_id and article_id = v_article_id;
    else
      insert into public.article_sync_records (
        owner_id, article_id, title, content, source_type, source_id,
        source_title, source_attribution, created_at_client, updated_at_client,
        deleted_at_client, revision, cursor
      ) values (
        v_owner_id, v_article_id, v_projection->>'title', v_projection->>'content',
        v_projection->>'sourceType', v_projection->>'sourceId',
        v_projection->>'sourceTitle', v_projection->>'sourceAttribution',
        v_projection->>'createdAt', v_projection->>'updatedAt',
        v_projection->>'deletedAt', v_revision, v_cursor
      );
    end if;
    v_result := pg_catalog.jsonb_build_object(
      'status', 'applied', 'mutationId', v_mutation_id,
      'articleId', v_article_id, 'operation', v_operation,
      'revision', 'revision:' || v_revision::text,
      'cursor', 'cursor:' || v_cursor::text
    );
  end if;

  insert into public.article_sync_mutations (
    owner_id, mutation_id, request_hash, article_id, operation,
    resulting_revision, resulting_cursor, mutation_result
  ) values (
    v_owner_id, v_mutation_id, v_request_hash, v_article_id, v_operation,
    v_revision, v_cursor, v_result
  );
  return v_result;
end;
$$;

create or replace function public.lingoflow_article_sync_pull(
  p_expected_owner_id uuid,
  p_after_cursor text default null,
  p_limit integer default 10
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
  v_limit integer := coalesce(p_limit, 10);
  v_changes jsonb := '[]'::jsonb;
  v_next bigint;
  v_has_more boolean;
begin
  if v_owner_id is null then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'reason', 'authentication-required',
      'changes', '[]'::jsonb, 'nextCursor', null, 'hasMore', false
    );
  end if;
  if p_expected_owner_id is distinct from v_owner_id then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'reason', 'owner-context-mismatch',
      'changes', '[]'::jsonb, 'nextCursor', null, 'hasMore', false
    );
  end if;
  if v_limit < 1 or v_limit > 25 then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'reason', 'invalid-limit',
      'changes', '[]'::jsonb, 'nextCursor', null, 'hasMore', false
    );
  end if;
  if p_after_cursor is not null then
    if p_after_cursor !~ '^cursor:(0|[1-9][0-9]*)$' then
      return pg_catalog.jsonb_build_object(
        'status', 'rejected', 'reason', 'invalid-cursor',
        'changes', '[]'::jsonb, 'nextCursor', null, 'hasMore', false
      );
    end if;
    begin
      v_after := pg_catalog.substr(p_after_cursor, 8)::bigint;
    exception when numeric_value_out_of_range then
      return pg_catalog.jsonb_build_object(
        'status', 'rejected', 'reason', 'invalid-cursor',
        'changes', '[]'::jsonb, 'nextCursor', null, 'hasMore', false
      );
    end;
  end if;
  select coalesce(pg_catalog.max(cursor), 0::bigint) into v_head
    from public.article_sync_changes where owner_id = v_owner_id;
  if v_after > v_head then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'reason', 'cursor-out-of-range',
      'changes', '[]'::jsonb, 'nextCursor', null, 'hasMore', false
    );
  end if;
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'cursor', 'cursor:' || c.cursor::text,
      'articleId', c.article_id,
      'operation', c.operation,
      'revision', 'revision:' || c.revision::text,
      'projection', c.projection
    ) order by c.cursor
  ), '[]'::jsonb), coalesce(pg_catalog.max(c.cursor), v_after)
    into v_changes, v_next
    from (
      select cursor, article_id, operation, revision, projection
      from public.article_sync_changes
      where owner_id = v_owner_id and cursor > v_after
      order by cursor limit v_limit
    ) c;
  select exists (
    select 1 from public.article_sync_changes
    where owner_id = v_owner_id and cursor > v_next
  ) into v_has_more;
  return pg_catalog.jsonb_build_object(
    'status', 'ready', 'changes', v_changes,
    'nextCursor', 'cursor:' || v_next::text, 'hasMore', v_has_more
  );
end;
$$;

create or replace function public.lingoflow_article_sync_snapshot(
  p_expected_owner_id uuid,
  p_article_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_record public.article_sync_records%rowtype;
begin
  if v_owner_id is null then
    return pg_catalog.jsonb_build_object('status', 'rejected', 'reason', 'authentication-required');
  end if;
  if p_expected_owner_id is distinct from v_owner_id then
    return pg_catalog.jsonb_build_object('status', 'rejected', 'reason', 'owner-context-mismatch');
  end if;
  if p_article_id is null or p_article_id = '' or
      pg_catalog.btrim(p_article_id) <> p_article_id then
    return pg_catalog.jsonb_build_object('status', 'rejected', 'reason', 'invalid-article-id');
  end if;
  select * into v_record from public.article_sync_records
    where owner_id = v_owner_id and article_id = p_article_id;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'missing', 'articleId', p_article_id);
  end if;
  return pg_catalog.jsonb_build_object(
    'status', 'found', 'articleId', p_article_id,
    'revision', 'revision:' || v_record.revision::text,
    'cursor', 'cursor:' || v_record.cursor::text,
    'lifecycle', case when v_record.deleted_at_client is null then 'active' else 'deleted' end,
    'projection', lingoflow_private.article_record_projection(v_record)
  );
end;
$$;

-- The exposed RPCs must be SECURITY DEFINER because direct writes/reads are
-- revoked. Empty search_path, explicit auth.uid() ownership, and no owner
-- argument as an authority keep the bypass narrow.
revoke all on function public.lingoflow_article_sync_push(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.lingoflow_article_sync_pull(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.lingoflow_article_sync_snapshot(uuid, text)
  from public, anon, authenticated;
grant execute on function public.lingoflow_article_sync_push(uuid, jsonb) to authenticated;
grant execute on function public.lingoflow_article_sync_pull(uuid, text, integer) to authenticated;
grant execute on function public.lingoflow_article_sync_snapshot(uuid, text) to authenticated;

revoke all on function lingoflow_private.is_article_client_timestamp(text) from public;
revoke all on function lingoflow_private.is_article_projection(jsonb, text) from public;
revoke all on function lingoflow_private.is_article_mutation(jsonb) from public;
revoke all on function lingoflow_private.article_record_projection(public.article_sync_records) from public;
