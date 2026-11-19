-- Notch grants are isolated from Todaywise's existing mobile Calendar sync.
create table public.notch_calendar_grants (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_grant text not null,
  updated_at timestamptz not null default now()
);
alter table public.notch_calendar_grants enable row level security;
revoke all on public.notch_calendar_grants from public, anon, authenticated;
grant select, insert, update, delete on public.notch_calendar_grants to service_role;
comment on table public.notch_calendar_grants is
  'Notch-only Google grants, AES-GCM encrypted with server-held key. No client access.';
