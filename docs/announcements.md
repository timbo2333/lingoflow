# Announcements V1

Announcements are public, read-only content. Publish through **Supabase Dashboard →
Table Editor → `public.announcements` → Insert row**. Do not put a service-role key or
database password in the browser or repository.

| Field | Meaning |
| --- | --- |
| `title` | Short plain-text heading (required). |
| `content` | Plain text; line breaks are preserved, HTML/Markdown are not rendered (required). |
| `importance` | `normal` (default) or `important`; important appears first. |
| `published_at` | First time the announcement becomes visible; defaults to insertion time. |
| `expires_at` | Optional end time; blank means no expiry. |
| `is_active` | Turn off to hide immediately; defaults to true. |

The database applies these visibility rules for both signed-out and signed-in
readers. Browser clients have `SELECT` only; they cannot insert, edit, or delete.
Dashboard/database-owner access is needed to publish or edit. `updated_at` is a
plain field in V1, not an automatic trigger.

Seen status lives only on the current device as announcement IDs. Editing the
title or content of an existing row **does not make it unread again**. To notify
readers again, insert a new row with a new ID. Seen status is not part of user
backup, account switching, or cloud sync.

Deploy `20260919120000_add_announcements.sql` before expecting the bell to show
remote rows. Until deployment, the app continues to work and the announcement
panel only shows a quiet unavailable message.

After deploying, verify permissions in the Dashboard SQL Editor with a
read-only check (both roles should show `can_select = true` and every write
column `false`):

```sql
select role_name,
  has_table_privilege(role_name, 'public.announcements', 'SELECT') as can_select,
  has_table_privilege(role_name, 'public.announcements', 'INSERT') as can_insert,
  has_table_privilege(role_name, 'public.announcements', 'UPDATE') as can_update,
  has_table_privilege(role_name, 'public.announcements', 'DELETE') as can_delete
from (values ('anon'), ('authenticated')) as roles(role_name);
```
