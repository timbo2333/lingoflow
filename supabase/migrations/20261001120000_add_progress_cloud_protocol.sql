-- V0.8B-3.1 server contract only. No browser Progress runtime is enabled here.
-- Article reading_epoch is server authority; Article revision remains unchanged.

-- The 1 MiB constraints are deliberately NOT VALID: historical oversized
-- Article data remains readable. PostgreSQL still checks NOT VALID constraints
-- on UPDATE, including metadata-only backfill. Replace them transactionally
-- around this backfill, then restore the exact same enforcement below.
alter table public.article_sync_records
  drop constraint article_sync_record_content_limit;
alter table public.article_sync_changes
  drop constraint article_sync_change_content_limit;

alter table public.article_sync_records
  add column reading_epoch uuid,
  add column content_fingerprint text;

alter table public.article_sync_changes
  add column reading_epoch uuid,
  add column content_fingerprint text;

-- Backfill historical snapshots in their actual per-Article cursor order. Each
-- content or lifecycle transition receives a new epoch, including A -> B -> A.
-- This is metadata backfill only: no Article revision/cursor/receipt is changed.
do $$
declare
  v_change record;
  v_previous_owner uuid;
  v_previous_article text;
  v_previous_content text;
  v_previous_deleted boolean;
  v_epoch uuid;
  v_content text;
  v_deleted boolean;
begin
  for v_change in
    select owner_id, article_id, cursor, projection
      from public.article_sync_changes
      order by owner_id, article_id, cursor
  loop
    v_content := v_change.projection->>'content';
    v_deleted := v_change.projection->>'deletedAt' is not null;
    if v_previous_owner is distinct from v_change.owner_id or
        v_previous_article is distinct from v_change.article_id or
        v_previous_content is distinct from v_content or
        v_previous_deleted is distinct from v_deleted then
      v_epoch := pg_catalog.gen_random_uuid();
    end if;
    update public.article_sync_changes set
      reading_epoch = v_epoch,
      content_fingerprint = 'sha256:' || pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(v_content, 'UTF8')), 'hex')
      where cursor = v_change.cursor;
    v_previous_owner := v_change.owner_id;
    v_previous_article := v_change.article_id;
    v_previous_content := v_content;
    v_previous_deleted := v_deleted;
  end loop;
end;
$$;

update public.article_sync_records r set
  reading_epoch = c.reading_epoch,
  content_fingerprint = 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(r.content, 'UTF8')), 'hex')
from public.article_sync_changes c
where c.owner_id = r.owner_id and c.article_id = r.article_id and
  c.cursor = r.cursor;

alter table public.article_sync_records
  add constraint article_sync_record_content_limit
  check (pg_catalog.octet_length(content) <= 1048576) not valid;
alter table public.article_sync_changes
  add constraint article_sync_change_content_limit
  check (pg_catalog.octet_length(projection->>'content') <= 1048576) not valid;

-- A malformed historical state should fail deployment rather than invent an
-- epoch that could falsely validate a Progress checkpoint.
alter table public.article_sync_records
  alter column reading_epoch set not null,
  alter column content_fingerprint set not null;
alter table public.article_sync_changes
  alter column reading_epoch set not null,
  alter column content_fingerprint set not null;
alter table public.article_sync_records
  add constraint article_sync_content_fingerprint_format
  check (content_fingerprint ~ '^sha256:[0-9a-f]{64}$');
alter table public.article_sync_changes
  add constraint article_change_content_fingerprint_format
  check (content_fingerprint ~ '^sha256:[0-9a-f]{64}$');

-- Only the Article RPC below is a legal client write path. This helper is its
-- single generation rule; direct table writes remain revoked.
create or replace function lingoflow_private.next_article_reading_epoch(
  p_existing_epoch uuid,
  p_existing_content text,
  p_existing_deleted_at text,
  p_new_content text,
  p_new_deleted_at text
)
returns uuid
language sql
volatile
set search_path = ''
as $$
  select case when p_existing_epoch is null or
    p_existing_content is distinct from p_new_content or
    (p_existing_deleted_at is null) is distinct from (p_new_deleted_at is null)
    then pg_catalog.gen_random_uuid() else p_existing_epoch end
$$;

revoke all on function lingoflow_private.next_article_reading_epoch(
  uuid, text, text, text, text) from public, anon, authenticated;

create table public.progress_sync_records (
  owner_id uuid not null,
  article_id text not null,
  progress double precision not null check (progress >= 0 and progress <= 1),
  paragraph_index integer not null check (paragraph_index >= 0),
  content_fingerprint text not null
    check (content_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  parent_reading_epoch uuid not null,
  server_revision bigint not null check (server_revision > 0),
  cursor bigint not null check (cursor > 0),
  server_updated_at timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (owner_id, article_id),
  foreign key (owner_id, article_id)
    references public.article_sync_records(owner_id, article_id) on delete cascade
);

create table public.progress_sync_changes (
  cursor bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  article_id text not null,
  server_revision bigint not null check (server_revision > 0),
  progress double precision not null check (progress >= 0 and progress <= 1),
  paragraph_index integer not null check (paragraph_index >= 0),
  content_fingerprint text not null
    check (content_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  parent_reading_epoch uuid not null,
  server_updated_at timestamptz not null default pg_catalog.statement_timestamp()
);
create index progress_sync_changes_owner_cursor_idx
  on public.progress_sync_changes (owner_id, cursor);

create table public.progress_sync_mutations (
  owner_id uuid not null references auth.users(id) on delete cascade,
  mutation_id text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  article_id text not null,
  resulting_revision bigint not null check (resulting_revision > 0),
  resulting_cursor bigint not null check (resulting_cursor > 0),
  mutation_result jsonb not null
    check (pg_catalog.jsonb_typeof(mutation_result) = 'object'),
  server_created_at timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (owner_id, mutation_id)
);

alter table public.progress_sync_records enable row level security;
alter table public.progress_sync_changes enable row level security;
alter table public.progress_sync_mutations enable row level security;

create policy progress_sync_records_owner_only on public.progress_sync_records
  for all to authenticated using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy progress_sync_changes_owner_only on public.progress_sync_changes
  for all to authenticated using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy progress_sync_mutations_owner_only on public.progress_sync_mutations
  for all to authenticated using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

revoke all on public.progress_sync_records from public, anon, authenticated;
revoke all on public.progress_sync_changes from public, anon, authenticated;
revoke all on public.progress_sync_mutations from public, anon, authenticated;
revoke all on sequence public.progress_sync_changes_cursor_seq
  from public, anon, authenticated;

-- The existing Article push remains the implementation of CAS, size checks,
-- receipts and change-log writes. The two triggers make epoch/fingerprint
-- maintenance independent of its callers and reject a current row that does
-- not correspond to its immutable change snapshot.
create or replace function lingoflow_private.prepare_article_change_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current public.article_sync_records%rowtype;
  v_content text := new.projection->>'content';
begin
  select * into v_current from public.article_sync_records
    where owner_id = new.owner_id and article_id = new.article_id;
  new.reading_epoch := lingoflow_private.next_article_reading_epoch(
    v_current.reading_epoch, v_current.content, v_current.deleted_at_client,
    v_content, new.projection->>'deletedAt'
  );
  new.content_fingerprint := 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_content, 'UTF8')), 'hex');
  return new;
end;
$$;

create trigger article_sync_changes_reading_context
  before insert on public.article_sync_changes
  for each row execute function lingoflow_private.prepare_article_change_context();

create or replace function lingoflow_private.apply_article_change_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_change public.article_sync_changes%rowtype;
begin
  select * into v_change from public.article_sync_changes where
    cursor = new.cursor and owner_id = new.owner_id and article_id = new.article_id;
  if not found or new.content is distinct from v_change.projection->>'content' or
      new.deleted_at_client is distinct from v_change.projection->>'deletedAt' or
      new.revision is distinct from v_change.revision then
    raise exception 'Article current row must match its immutable change';
  end if;
  new.reading_epoch := v_change.reading_epoch;
  new.content_fingerprint := v_change.content_fingerprint;
  return new;
end;
$$;

create trigger article_sync_records_reading_context
  before insert or update on public.article_sync_records
  for each row execute function lingoflow_private.apply_article_change_context();

revoke all on function lingoflow_private.prepare_article_change_context()
  from public, anon, authenticated;
revoke all on function lingoflow_private.apply_article_change_context()
  from public, anon, authenticated;

-- Move the latest Article implementation unchanged. The public wrapper adds
-- metadata from the historical change referenced by its result, so even an
-- old idempotent receipt returns the original epoch rather than today's row.
alter function public.lingoflow_article_sync_push(uuid, jsonb)
  set schema lingoflow_private;
alter function lingoflow_private.lingoflow_article_sync_push(uuid, jsonb)
  rename to article_sync_push_core;
revoke all on function lingoflow_private.article_sync_push_core(uuid, jsonb)
  from public, anon, authenticated;

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
  v_result jsonb;
  v_context public.article_sync_changes%rowtype;
begin
  v_result := lingoflow_private.article_sync_push_core(
    p_expected_owner_id, p_mutation);
  if v_result->>'status' not in ('applied', 'unchanged') then
    return v_result;
  end if;
  select * into v_context from public.article_sync_changes
    where owner_id = (select auth.uid()) and article_id = v_result->>'articleId'
      and 'cursor:' || cursor::text = v_result->>'cursor';
  if not found then
    raise exception 'Article receipt cursor has no change snapshot';
  end if;
  return v_result || pg_catalog.jsonb_build_object(
    'readingEpoch', v_context.reading_epoch::text,
    'contentFingerprint', v_context.content_fingerprint
  );
end;
$$;

revoke all on function public.lingoflow_article_sync_push(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.lingoflow_article_sync_push(uuid, jsonb)
  to authenticated;

-- Article pull remains the existing bounded change stream. The two fields
-- are additive top-level metadata; the legacy projection is unchanged.
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
      'changes', '[]'::jsonb, 'nextCursor', null, 'hasMore', false);
  end if;
  if p_expected_owner_id is distinct from v_owner_id then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'reason', 'owner-context-mismatch',
      'changes', '[]'::jsonb, 'nextCursor', null, 'hasMore', false);
  end if;
  if v_limit < 1 or v_limit > 25 then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'reason', 'invalid-limit',
      'changes', '[]'::jsonb, 'nextCursor', null, 'hasMore', false);
  end if;
  if p_after_cursor is not null then
    if p_after_cursor !~ '^cursor:(0|[1-9][0-9]*)$' then
      return pg_catalog.jsonb_build_object(
        'status', 'rejected', 'reason', 'invalid-cursor',
        'changes', '[]'::jsonb, 'nextCursor', null, 'hasMore', false);
    end if;
    begin
      v_after := pg_catalog.substr(p_after_cursor, 8)::bigint;
    exception when numeric_value_out_of_range then
      return pg_catalog.jsonb_build_object(
        'status', 'rejected', 'reason', 'invalid-cursor',
        'changes', '[]'::jsonb, 'nextCursor', null, 'hasMore', false);
    end;
  end if;
  select coalesce(pg_catalog.max(cursor), 0::bigint) into v_head
    from public.article_sync_changes where owner_id = v_owner_id;
  if v_after > v_head then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'reason', 'cursor-out-of-range',
      'changes', '[]'::jsonb, 'nextCursor', null, 'hasMore', false);
  end if;
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'cursor', 'cursor:' || c.cursor::text,
      'articleId', c.article_id, 'operation', c.operation,
      'revision', 'revision:' || c.revision::text,
      'projection', c.projection,
      'readingEpoch', c.reading_epoch::text,
      'contentFingerprint', c.content_fingerprint
    ) order by c.cursor
  ), '[]'::jsonb), coalesce(pg_catalog.max(c.cursor), v_after)
    into v_changes, v_next
    from (
      select cursor, article_id, operation, revision, projection,
        reading_epoch, content_fingerprint
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
    'nextCursor', 'cursor:' || v_next::text, 'hasMore', v_has_more);
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
    'projection', lingoflow_private.article_record_projection(v_record),
    'readingEpoch', v_record.reading_epoch::text,
    'contentFingerprint', v_record.content_fingerprint
  );
end;
$$;

-- Strict request shape. UNKNOWN is not a legal expectedState. A future client
-- may send "absent" only after a completed remote observation; the server
-- additionally verifies that the row is still absent under the owner lock.
create or replace function lingoflow_private.is_progress_mutation(p_mutation jsonb)
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
        'mutationId', 'articleId', 'expectedState',
        'expectedProgressRevision', 'parentReadingEpoch',
        'contentFingerprint', 'progress', 'paragraphIndex'
      ]) then
    return false;
  end if;
  for v_key in select k from pg_catalog.jsonb_object_keys(p_mutation) as keys(k)
  loop
    if v_key not in (
      'mutationId', 'articleId', 'expectedState',
      'expectedProgressRevision', 'parentReadingEpoch',
      'contentFingerprint', 'progress', 'paragraphIndex'
    ) then
      return false;
    end if;
  end loop;
  if pg_catalog.jsonb_typeof(p_mutation->'mutationId') <> 'string' or
      pg_catalog.length(p_mutation->>'mutationId') not between 1 and 200 or
      pg_catalog.btrim(p_mutation->>'mutationId') <> p_mutation->>'mutationId' or
      pg_catalog.jsonb_typeof(p_mutation->'articleId') <> 'string' or
      p_mutation->>'articleId' = '' or
      pg_catalog.btrim(p_mutation->>'articleId') <> p_mutation->>'articleId' or
      pg_catalog.jsonb_typeof(p_mutation->'expectedState') <> 'string' or
      p_mutation->>'expectedState' not in ('absent', 'revision') or
      pg_catalog.jsonb_typeof(p_mutation->'parentReadingEpoch') <> 'string' or
      pg_catalog.jsonb_typeof(p_mutation->'contentFingerprint') <> 'string' or
      p_mutation->>'contentFingerprint' !~ '^sha256:[0-9a-f]{64}$' then
    return false;
  end if;
  if (p_mutation->>'parentReadingEpoch')::uuid::text <>
      p_mutation->>'parentReadingEpoch' then
    return false;
  end if;
  if p_mutation->>'expectedState' = 'absent' then
    if pg_catalog.jsonb_typeof(p_mutation->'expectedProgressRevision') <> 'null' then
      return false;
    end if;
  else
    if pg_catalog.jsonb_typeof(p_mutation->'expectedProgressRevision') <> 'string' or
        p_mutation->>'expectedProgressRevision' !~ '^revision:[1-9][0-9]*$' then
      return false;
    end if;
    perform pg_catalog.substr(p_mutation->>'expectedProgressRevision', 10)::bigint;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

revoke all on function lingoflow_private.is_progress_mutation(jsonb)
  from public, anon, authenticated;

create or replace function public.lingoflow_progress_sync_push(
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
  v_request_hash text;
  v_receipt public.progress_sync_mutations%rowtype;
  v_parent public.article_sync_records%rowtype;
  v_current public.progress_sync_records%rowtype;
  v_has_current boolean;
  v_progress double precision;
  v_paragraph_index integer;
  v_epoch uuid;
  v_fingerprint text;
  v_expected_revision bigint;
  v_revision bigint;
  v_cursor bigint;
  v_updated_at timestamptz;
  v_result jsonb;
begin
  if v_owner_id is null then
    return pg_catalog.jsonb_build_object('status', 'rejected', 'reason', 'authentication-required');
  end if;
  if p_expected_owner_id is distinct from v_owner_id then
    return pg_catalog.jsonb_build_object('status', 'rejected', 'reason', 'owner-context-mismatch');
  end if;
  if not lingoflow_private.is_progress_mutation(p_mutation) then
    return pg_catalog.jsonb_build_object('status', 'rejected', 'reason', 'invalid-mutation');
  end if;
  begin
    if pg_catalog.jsonb_typeof(p_mutation->'progress') <> 'number' or
        pg_catalog.jsonb_typeof(p_mutation->'paragraphIndex') <> 'number' or
        p_mutation->>'paragraphIndex' !~ '^(0|[1-9][0-9]*)$' or
        (p_mutation->>'progress')::numeric < 0 or
        (p_mutation->>'progress')::numeric > 1 then
      return pg_catalog.jsonb_build_object('status', 'rejected', 'reason', 'invalid-checkpoint');
    end if;
    v_progress := (p_mutation->>'progress')::double precision;
    v_paragraph_index := (p_mutation->>'paragraphIndex')::integer;
  exception when others then
    return pg_catalog.jsonb_build_object('status', 'rejected', 'reason', 'invalid-checkpoint');
  end;

  v_mutation_id := p_mutation->>'mutationId';
  v_article_id := p_mutation->>'articleId';
  v_epoch := (p_mutation->>'parentReadingEpoch')::uuid;
  v_fingerprint := p_mutation->>'contentFingerprint';
  v_request_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_mutation::text, 'UTF8')), 'hex');
  if p_mutation->>'expectedState' = 'revision' then
    v_expected_revision := pg_catalog.substr(
      p_mutation->>'expectedProgressRevision', 10)::bigint;
  end if;

  -- Same lock as Article push: no Article content/delete/restore can race
  -- between parent validation and Progress settlement. It also serializes
  -- owner change-log commits so cursors are observed in commit order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_owner_id::text, 210921));
  select * into v_receipt from public.progress_sync_mutations
    where owner_id = v_owner_id and mutation_id = v_mutation_id;
  if found then
    if v_receipt.request_hash = v_request_hash then
      return v_receipt.mutation_result;
    end if;
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'reason', 'mutation-id-reuse',
      'mutationId', v_mutation_id, 'articleId', v_article_id);
  end if;

  select * into v_parent from public.article_sync_records
    where owner_id = v_owner_id and article_id = v_article_id for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'reason', 'parent-not-ready',
      'mutationId', v_mutation_id, 'articleId', v_article_id);
  end if;
  if v_parent.deleted_at_client is not null then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'reason', 'article-deleted',
      'mutationId', v_mutation_id, 'articleId', v_article_id);
  end if;
  if v_parent.reading_epoch is distinct from v_epoch then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'reason', 'parent-epoch-mismatch',
      'mutationId', v_mutation_id, 'articleId', v_article_id);
  end if;
  if v_parent.content_fingerprint is distinct from v_fingerprint then
    return pg_catalog.jsonb_build_object(
      'status', 'rejected', 'reason', 'fingerprint-mismatch',
      'mutationId', v_mutation_id, 'articleId', v_article_id);
  end if;

  select * into v_current from public.progress_sync_records
    where owner_id = v_owner_id and article_id = v_article_id for update;
  v_has_current := found;
  if (p_mutation->>'expectedState' = 'absent' and v_has_current) or
      (p_mutation->>'expectedState' = 'revision' and
       (not v_has_current or v_current.server_revision <> v_expected_revision)) then
    return pg_catalog.jsonb_build_object(
      'status', 'conflict', 'reason', 'revision-mismatch',
      'mutationId', v_mutation_id, 'articleId', v_article_id,
      'currentRevision', case when v_has_current
        then 'revision:' || v_current.server_revision::text else null end,
      'currentCursor', case when v_has_current
        then 'cursor:' || v_current.cursor::text else null end);
  end if;

  if v_has_current and v_current.progress = v_progress and
      v_current.paragraph_index = v_paragraph_index and
      v_current.parent_reading_epoch = v_epoch and
      v_current.content_fingerprint = v_fingerprint then
    -- Valid CAS no-op: no revision or change, but a durable success receipt.
    v_revision := v_current.server_revision;
    v_cursor := v_current.cursor;
    v_updated_at := v_current.server_updated_at;
    v_result := pg_catalog.jsonb_build_object(
      'status', 'unchanged', 'mutationId', v_mutation_id,
      'articleId', v_article_id,
      'revision', 'revision:' || v_revision::text,
      'cursor', 'cursor:' || v_cursor::text,
      'progress', v_progress, 'paragraphIndex', v_paragraph_index,
      'parentReadingEpoch', v_epoch::text,
      'contentFingerprint', v_fingerprint,
      'serverUpdatedAt', v_updated_at);
  else
    v_revision := case when v_has_current then v_current.server_revision + 1 else 1 end;
    v_updated_at := pg_catalog.statement_timestamp();
    insert into public.progress_sync_changes (
      owner_id, article_id, server_revision, progress, paragraph_index,
      content_fingerprint, parent_reading_epoch, server_updated_at
    ) values (
      v_owner_id, v_article_id, v_revision, v_progress, v_paragraph_index,
      v_fingerprint, v_epoch, v_updated_at
    ) returning cursor into v_cursor;
    if v_has_current then
      update public.progress_sync_records set
        progress = v_progress, paragraph_index = v_paragraph_index,
        content_fingerprint = v_fingerprint, parent_reading_epoch = v_epoch,
        server_revision = v_revision, cursor = v_cursor,
        server_updated_at = v_updated_at
      where owner_id = v_owner_id and article_id = v_article_id;
    else
      insert into public.progress_sync_records (
        owner_id, article_id, progress, paragraph_index,
        content_fingerprint, parent_reading_epoch,
        server_revision, cursor, server_updated_at
      ) values (
        v_owner_id, v_article_id, v_progress, v_paragraph_index,
        v_fingerprint, v_epoch, v_revision, v_cursor, v_updated_at);
    end if;
    v_result := pg_catalog.jsonb_build_object(
      'status', 'applied', 'mutationId', v_mutation_id,
      'articleId', v_article_id,
      'revision', 'revision:' || v_revision::text,
      'cursor', 'cursor:' || v_cursor::text,
      'progress', v_progress, 'paragraphIndex', v_paragraph_index,
      'parentReadingEpoch', v_epoch::text,
      'contentFingerprint', v_fingerprint,
      'serverUpdatedAt', v_updated_at);
  end if;

  insert into public.progress_sync_mutations (
    owner_id, mutation_id, request_hash, article_id,
    resulting_revision, resulting_cursor, mutation_result
  ) values (
    v_owner_id, v_mutation_id, v_request_hash, v_article_id,
    v_revision, v_cursor, v_result);
  return v_result;
end;
$$;

create or replace function public.lingoflow_progress_sync_pull(
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
    return pg_catalog.jsonb_build_object('status', 'rejected',
      'reason', 'authentication-required', 'changes', '[]'::jsonb,
      'nextCursor', null, 'hasMore', false);
  end if;
  if p_expected_owner_id is distinct from v_owner_id then
    return pg_catalog.jsonb_build_object('status', 'rejected',
      'reason', 'owner-context-mismatch', 'changes', '[]'::jsonb,
      'nextCursor', null, 'hasMore', false);
  end if;
  if v_limit < 1 or v_limit > 25 then
    return pg_catalog.jsonb_build_object('status', 'rejected',
      'reason', 'invalid-limit', 'changes', '[]'::jsonb,
      'nextCursor', null, 'hasMore', false);
  end if;
  if p_after_cursor is not null then
    if p_after_cursor !~ '^cursor:(0|[1-9][0-9]*)$' then
      return pg_catalog.jsonb_build_object('status', 'rejected',
        'reason', 'invalid-cursor', 'changes', '[]'::jsonb,
        'nextCursor', null, 'hasMore', false);
    end if;
    begin
      v_after := pg_catalog.substr(p_after_cursor, 8)::bigint;
    exception when numeric_value_out_of_range then
      return pg_catalog.jsonb_build_object('status', 'rejected',
        'reason', 'invalid-cursor', 'changes', '[]'::jsonb,
        'nextCursor', null, 'hasMore', false);
    end;
  end if;
  select coalesce(pg_catalog.max(cursor), 0::bigint) into v_head
    from public.progress_sync_changes where owner_id = v_owner_id;
  if v_after > v_head then
    return pg_catalog.jsonb_build_object('status', 'rejected',
      'reason', 'cursor-out-of-range', 'changes', '[]'::jsonb,
      'nextCursor', null, 'hasMore', false);
  end if;
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'cursor', 'cursor:' || c.cursor::text,
      'articleId', c.article_id,
      'revision', 'revision:' || c.server_revision::text,
      'progress', c.progress,
      'paragraphIndex', c.paragraph_index,
      'contentFingerprint', c.content_fingerprint,
      'parentReadingEpoch', c.parent_reading_epoch::text,
      'serverUpdatedAt', c.server_updated_at
    ) order by c.cursor
  ), '[]'::jsonb), coalesce(pg_catalog.max(c.cursor), v_after)
    into v_changes, v_next
    from (
      select cursor, article_id, server_revision, progress, paragraph_index,
        content_fingerprint, parent_reading_epoch, server_updated_at
      from public.progress_sync_changes
      where owner_id = v_owner_id and cursor > v_after
      order by cursor limit v_limit
    ) c;
  select exists (
    select 1 from public.progress_sync_changes
    where owner_id = v_owner_id and cursor > v_next
  ) into v_has_more;
  return pg_catalog.jsonb_build_object(
    'status', 'ready', 'changes', v_changes,
    'nextCursor', 'cursor:' || v_next::text, 'hasMore', v_has_more);
end;
$$;

-- Keyset scan of current rows at a fixed owner high-water. Rows updated after
-- that high-water disappear from this scan but are recovered by pull(highWater).
-- A new startup performs one inventory; subsequent startups use the pull cursor.
create or replace function public.lingoflow_progress_sync_inventory(
  p_expected_owner_id uuid,
  p_after_article_id text default null,
  p_high_water_cursor text default null,
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_head bigint := 0;
  v_high_water bigint := 0;
  v_limit integer := coalesce(p_limit, 10);
  v_rows jsonb := '[]'::jsonb;
  v_next_article_id text;
  v_has_more boolean;
begin
  if v_owner_id is null then
    return pg_catalog.jsonb_build_object('status', 'rejected',
      'reason', 'authentication-required');
  end if;
  if p_expected_owner_id is distinct from v_owner_id then
    return pg_catalog.jsonb_build_object('status', 'rejected',
      'reason', 'owner-context-mismatch');
  end if;
  if v_limit < 1 or v_limit > 25 then
    return pg_catalog.jsonb_build_object('status', 'rejected',
      'reason', 'invalid-limit');
  end if;
  if p_after_article_id is not null and
      (p_after_article_id = '' or pg_catalog.btrim(p_after_article_id) <> p_after_article_id) then
    return pg_catalog.jsonb_build_object('status', 'rejected',
      'reason', 'invalid-article-id');
  end if;
  if (p_after_article_id is null) is distinct from
      (p_high_water_cursor is null) then
    return pg_catalog.jsonb_build_object('status', 'rejected',
      'reason', 'invalid-inventory-page');
  end if;
  select coalesce(pg_catalog.max(cursor), 0::bigint) into v_head
    from public.progress_sync_changes where owner_id = v_owner_id;
  if p_high_water_cursor is null then
    v_high_water := v_head;
  else
    if p_high_water_cursor !~ '^cursor:(0|[1-9][0-9]*)$' then
      return pg_catalog.jsonb_build_object('status', 'rejected',
        'reason', 'invalid-cursor');
    end if;
    begin
      v_high_water := pg_catalog.substr(p_high_water_cursor, 8)::bigint;
    exception when numeric_value_out_of_range then
      return pg_catalog.jsonb_build_object('status', 'rejected',
        'reason', 'invalid-cursor');
    end;
    if v_high_water > v_head then
      return pg_catalog.jsonb_build_object('status', 'rejected',
        'reason', 'cursor-out-of-range');
    end if;
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'articleId', r.article_id,
      'revision', 'revision:' || r.server_revision::text,
      'cursor', 'cursor:' || r.cursor::text,
      'progress', r.progress,
      'paragraphIndex', r.paragraph_index,
      'contentFingerprint', r.content_fingerprint,
      'parentReadingEpoch', r.parent_reading_epoch::text,
      'serverUpdatedAt', r.server_updated_at
    ) order by r.article_id
  ), '[]'::jsonb), pg_catalog.max(r.article_id)
    into v_rows, v_next_article_id
    from (
      select article_id, server_revision, cursor, progress,
        paragraph_index, content_fingerprint, parent_reading_epoch,
        server_updated_at
      from public.progress_sync_records
      where owner_id = v_owner_id and cursor <= v_high_water and
        (p_after_article_id is null or article_id > p_after_article_id)
      order by article_id limit v_limit
    ) r;
  select exists (
    select 1 from public.progress_sync_records
    where owner_id = v_owner_id and cursor <= v_high_water and
      article_id > v_next_article_id
  ) into v_has_more;
  return pg_catalog.jsonb_build_object(
    'status', 'ready', 'rows', v_rows,
    'highWaterCursor', 'cursor:' || v_high_water::text,
    'nextArticleId', v_next_article_id,
    'hasMore', v_has_more
  );
end;
$$;

revoke all on function public.lingoflow_progress_sync_push(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.lingoflow_progress_sync_pull(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.lingoflow_progress_sync_inventory(uuid, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.lingoflow_progress_sync_push(uuid, jsonb)
  to authenticated;
grant execute on function public.lingoflow_progress_sync_pull(uuid, text, integer)
  to authenticated;
grant execute on function public.lingoflow_progress_sync_inventory(uuid, text, text, integer)
  to authenticated;
