-- V0.8A-4.1: preserve a pre-sync local delete when the owner's cloud record
-- does not exist yet. Existing records still require the normal revision CAS.
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
    if v_operation not in ('put', 'delete') then
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
      -- A null-base delete is only valid in this absent-record branch. It
      -- creates revision 1 with the complete deleted projection.
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

revoke all on function public.lingoflow_article_sync_push(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.lingoflow_article_sync_push(uuid, jsonb) to authenticated;
