-- Optional email accounts and alerts.
--
-- 1. sync_accounts: a Supabase Auth user (email + optional password, or magic link) remembers one
--    sync key. The first device to sign in stores its key; any later device that signs in adopts
--    it (and merges its own list into it), exactly like pairing with a code.
-- 2. alert_subscriptions: per sync key (stored as its hash), whether alerts are on, the optional
--    email channel (an auth user, email read from auth.users at send time, confirmed only) and the
--    web push subscriptions of the devices that turned on notifications.
-- 3. alert_secret: HMAC secret for one-click unsubscribe links, readable only by the collector
--    (database owner) and the SECURITY DEFINER unsubscribe function.
-- All tables: RLS on, no grants. Browsers use only the functions below.

create table if not exists public.sync_accounts (
  user_id uuid primary key references auth.users on delete cascade,
  sync_key text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.alert_subscriptions (
  key_hash text primary key,
  enabled boolean not null default false,
  user_id uuid references auth.users on delete set null,
  push jsonb not null default '[]'::jsonb,
  push_cursor timestamptz not null default now(),
  email_cursor timestamptz not null default now(),
  last_email_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists alert_subscriptions_enabled on public.alert_subscriptions (enabled) where enabled;

create table if not exists public.alert_secret (
  id boolean primary key default true check (id),
  secret bytea not null default extensions.gen_random_bytes(32)
);
insert into public.alert_secret default values on conflict (id) do nothing;

alter table public.sync_accounts enable row level security;
alter table public.alert_subscriptions enable row level security;
alter table public.alert_secret enable row level security;
revoke all on public.sync_accounts, public.alert_subscriptions, public.alert_secret from anon, authenticated;

-- Signed-in user: store this device's key if the account has none yet, and return the account's key.
create or replace function public.account_link(p_key text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  stored text;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  perform public.sync_key_hash(p_key);
  insert into public.sync_accounts (user_id, sync_key) values (uid, p_key) on conflict (user_id) do nothing;
  select sync_key into stored from public.sync_accounts where user_id = uid;
  return stored;
end;
$$;

-- Alert settings for a key; the email is masked (j***@example.com) and only shown when confirmed.
create or replace function public.alerts_get(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  row public.alert_subscriptions;
  mail text;
begin
  select * into row from public.alert_subscriptions where key_hash = public.sync_key_hash(p_key);
  if not found then
    return jsonb_build_object('enabled', false, 'email', null, 'push', '[]'::jsonb);
  end if;
  if row.user_id is not null then
    select regexp_replace(u.email, '^(.)[^@]*', '\1***') into mail
    from auth.users u where u.id = row.user_id and u.email_confirmed_at is not null;
  end if;
  return jsonb_build_object(
    'enabled', row.enabled,
    'email', mail,
    'push', coalesce((select jsonb_agg(s->>'endpoint') from jsonb_array_elements(row.push) s), '[]'::jsonb)
  );
end;
$$;

-- Turn alerts on/off and attach (true) or detach (false) the signed-in user's email; null leaves it.
create or replace function public.alerts_set(p_key text, p_enabled boolean, p_email boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h text := public.sync_key_hash(p_key);
begin
  if p_email is true and auth.uid() is null then
    raise exception 'sign in to get alerts by email' using errcode = '28000';
  end if;
  insert into public.alert_subscriptions (key_hash, enabled, user_id)
  values (h, coalesce(p_enabled, false), case when p_email is true then auth.uid() end)
  on conflict (key_hash) do update set
    enabled = coalesce(p_enabled, alert_subscriptions.enabled),
    user_id = case when p_email is true then auth.uid() when p_email is false then null else alert_subscriptions.user_id end,
    -- Re-enabling starts from now: no backlog of everything collected while alerts were off.
    push_cursor = case when p_enabled and not alert_subscriptions.enabled then now() else alert_subscriptions.push_cursor end,
    email_cursor = case when (p_enabled and not alert_subscriptions.enabled) or (p_email is true and alert_subscriptions.user_id is null)
      then now() else alert_subscriptions.email_cursor end,
    updated_at = now();
  return public.alerts_get(p_key);
end;
$$;

-- Add this device's push subscription (deduplicated by endpoint, at most 10 per key).
create or replace function public.alerts_push_add(p_key text, p_sub jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h text := public.sync_key_hash(p_key);
  endpoint text := p_sub->>'endpoint';
  sub jsonb;
begin
  if endpoint is null or endpoint !~ '^https://' or length(endpoint) > 1000
     or coalesce(p_sub->'keys'->>'p256dh', '') = '' or coalesce(p_sub->'keys'->>'auth', '') = '' then
    raise exception 'invalid push subscription' using errcode = '22023';
  end if;
  sub := jsonb_build_object('endpoint', endpoint, 'keys', jsonb_build_object('p256dh', p_sub->'keys'->>'p256dh', 'auth', p_sub->'keys'->>'auth'));
  insert into public.alert_subscriptions (key_hash, enabled, push) values (h, true, jsonb_build_array(sub))
  on conflict (key_hash) do update set
    push = (
      select coalesce(jsonb_agg(s), '[]'::jsonb) from (
        select s from jsonb_array_elements(alert_subscriptions.push) s where s->>'endpoint' <> endpoint
        union all select sub
      ) t(s)
    ),
    push_cursor = case when not alert_subscriptions.enabled then now() else alert_subscriptions.push_cursor end,
    enabled = true,
    updated_at = now();
  if jsonb_array_length((select push from public.alert_subscriptions where key_hash = h)) > 10 then
    raise exception 'too many devices with notifications' using errcode = '22023';
  end if;
  return public.alerts_get(p_key);
end;
$$;

create or replace function public.alerts_push_remove(p_key text, p_endpoint text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.alert_subscriptions set
    push = coalesce((select jsonb_agg(s) from jsonb_array_elements(push) s where s->>'endpoint' <> p_endpoint), '[]'::jsonb),
    updated_at = now()
  where key_hash = public.sync_key_hash(p_key);
  return public.alerts_get(p_key);
end;
$$;

-- One-click unsubscribe from an email: the link carries the key hash and its HMAC.
create or replace function public.alerts_unsubscribe(p_key_hash text, p_sig text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected text;
begin
  if p_key_hash !~ '^[0-9a-f]{64}$' or p_sig !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  select encode(extensions.hmac(convert_to(p_key_hash, 'UTF8'), secret, 'sha256'), 'hex') into expected from public.alert_secret;
  if expected is distinct from p_sig then
    return false;
  end if;
  update public.alert_subscriptions set user_id = null, updated_at = now() where key_hash = p_key_hash;
  update public.alert_subscriptions set enabled = false where key_hash = p_key_hash and jsonb_array_length(push) = 0;
  return true;
end;
$$;

revoke all on function public.account_link(text) from public, anon;
revoke all on function public.alerts_get(text) from public;
revoke all on function public.alerts_set(text, boolean, boolean) from public;
revoke all on function public.alerts_push_add(text, jsonb) from public;
revoke all on function public.alerts_push_remove(text, text) from public;
revoke all on function public.alerts_unsubscribe(text, text) from public;
grant execute on function public.account_link(text) to authenticated;
grant execute on function public.alerts_get(text) to anon, authenticated;
grant execute on function public.alerts_set(text, boolean, boolean) to anon, authenticated;
grant execute on function public.alerts_push_add(text, jsonb) to anon, authenticated;
grant execute on function public.alerts_push_remove(text, text) to anon, authenticated;
grant execute on function public.alerts_unsubscribe(text, text) to anon, authenticated;
