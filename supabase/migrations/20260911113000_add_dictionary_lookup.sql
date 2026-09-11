-- Dictionary 2.0 Cloud Lookup PoC.
-- Static public data is readable only through the single-word lookup RPC.

create table public.dictionary_entries (
  word text primary key,
  phonetic text,
  translation text not null,
  pos text,
  constraint dictionary_entries_word_canonical check (
    word = pg_catalog.btrim(word) and
    word = pg_catalog.lower(word) and
    word ~ '^[a-z]+(?:[''-][a-z]+)*$'
  ),
  constraint dictionary_entries_translation_not_blank check (
    pg_catalog.btrim(translation) <> ''
  )
);

alter table public.dictionary_entries enable row level security;

revoke all on table public.dictionary_entries from public, anon, authenticated;

create or replace function public.lookup_dictionary(p_word text)
returns table (
  word text,
  phonetic text,
  translation text,
  pos text
)
language sql
stable
security definer
set search_path = ''
rows 1
as $$
  select
    entry.word,
    entry.phonetic,
    entry.translation,
    entry.pos
  from public.dictionary_entries as entry
  where entry.word = p_word
  limit 1;
$$;

revoke all on function public.lookup_dictionary(text) from public;
grant execute on function public.lookup_dictionary(text) to anon, authenticated;
