-- Public, read-only announcements. Dashboard/database owners publish rows.
create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null,
  importance text not null default 'normal'
    constraint announcements_importance_check check (importance in ('normal', 'important')),
  published_at timestamptz not null default now(),
  expires_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.announcements enable row level security;

-- Supabase projects can auto-grant public-schema table privileges. Remove all
-- client writes explicitly; a SELECT policy alone does not revoke grants.
revoke all on table public.announcements from public, anon, authenticated;
grant select on table public.announcements to anon, authenticated;

create policy "Anyone can read currently published announcements"
on public.announcements
for select
to anon, authenticated
using (
  is_active = true
  and published_at <= now()
  and (expires_at is null or expires_at > now())
);
