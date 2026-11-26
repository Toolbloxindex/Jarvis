-- Account-free sync between devices.
--
-- Identity is a random secret "sync key" (>= 128 bits) generated in the browser. The database only
-- stores its SHA-256, so a database leak does not reveal keys. Tables are closed to the public API;
-- browsers reach them only through the SECURITY DEFINER functions below, which require the key.
-- Pairing a new device: device A asks for a short code (10 minutes, single use); device B redeems
-- it and receives A's key. Failed redemptions are throttled globally against brute force.

create table if not exists public.sync_states (
  key_hash text primary key,
  data jsonb not null default '{}'::jsonb,
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.sync_pair_codes (
  code text primary key,
  sync_key text not null,
  expires_at timestamptz not null
);

create table if not exists public.sync_pair_failures (
  at timestamptz not null default now()
);
create index if not exists sync_pair_failures_at on public.sync_pair_failures (at);

alter table public.sync_states enable row level security;
alter table public.sync_pair_codes enable row level security;
alter table public.sync_pair_failures enable row level security;
revoke all on public.sync_states, public.sync_pair_codes, public.sync_pair_failures from anon, authenticated;

create or replace function public.sync_key_hash(p_key text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_key is null or length(p_key) < 32 or length(p_key) > 128 or p_key !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'invalid sync key' using errcode = '22023';
  end if;
  return encode(extensions.digest(p_key, 'sha256'), 'hex');
end;
$$;

-- Read the synced document. Returns {data, version}; version 0 means nothing stored yet.
create or replace function public.sync_pull(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  row public.sync_states;
begin
  select * into row from public.sync_states where key_hash = public.sync_key_hash(p_key);
  if not found then
    return jsonb_build_object('data', '{}'::jsonb, 'version', 0);
  end if;
  return jsonb_build_object('data', row.data, 'version', row.version);
end;
$$;

-- Compare-and-set write. Succeeds only if the stored version still equals p_base; otherwise
-- returns the current document so the client can merge and retry.
create or replace function public.sync_push(p_key text, p_data jsonb, p_base bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h text := public.sync_key_hash(p_key);
  row public.sync_states;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' or pg_column_size(p_data) > 262144 then
    raise exception 'invalid sync document' using errcode = '22023';
  end if;
  if p_base = 0 then
    insert into public.sync_states (key_hash, data, version) values (h, p_data, 1)
    on conflict (key_hash) do nothing;
    if found then
      return jsonb_build_object('ok', true, 'version', 1);
    end if;
  else
    update public.sync_states set data = p_data, version = version + 1, updated_at = now()
    where key_hash = h and version = p_base
    returning * into row;
    if found then
      return jsonb_build_object('ok', true, 'version', row.version);
    end if;
  end if;
  select * into row from public.sync_states where key_hash = h;
  return jsonb_build_object('ok', false, 'data', coalesce(row.data, '{}'::jsonb), 'version', coalesce(row.version, 0));
end;
$$;

-- A 6-character pairing code for this key (no 0/O/1/I/L), valid 10 minutes, single use.
create or replace function public.sync_pair_create(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  bytes bytea;
  new_code text;
  i int;
  expires timestamptz := now() + interval '10 minutes';
begin
  perform public.sync_key_hash(p_key); -- validates the key
  delete from public.sync_pair_codes where expires_at < now() or sync_key = p_key;
  loop
    bytes := extensions.gen_random_bytes(6);
    new_code := '';
    for i in 0..5 loop
      new_code := new_code || substr(alphabet, 1 + (get_byte(bytes, i) % length(alphabet)), 1);
    end loop;
    begin
      insert into public.sync_pair_codes (code, sync_key, expires_at) values (new_code, p_key, expires);
      exit;
    exception when unique_violation then
      -- astronomically rare: draw again
    end;
  end loop;
  return jsonb_build_object('code', new_code, 'expiresAt', expires);
end;
$$;

-- Redeem a pairing code: returns the key once, then the code is gone.
create or replace function public.sync_pair_claim(p_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  claimed text;
begin
  if (select count(*) from public.sync_pair_failures where at > now() - interval '10 minutes') >= 200 then
    raise exception 'too many attempts, try again in a few minutes' using errcode = 'P0001';
  end if;
  delete from public.sync_pair_codes
  where code = normalized and expires_at > now()
  returning sync_key into claimed;
  if claimed is null then
    insert into public.sync_pair_failures default values;
    delete from public.sync_pair_failures where at < now() - interval '1 day';
  end if;
  return claimed;
end;
$$;

revoke all on function public.sync_key_hash(text) from public;
revoke all on function public.sync_pull(text) from public;
revoke all on function public.sync_push(text, jsonb, bigint) from public;
revoke all on function public.sync_pair_create(text) from public;
revoke all on function public.sync_pair_claim(text) from public;
grant execute on function public.sync_pull(text) to anon, authenticated;
grant execute on function public.sync_push(text, jsonb, bigint) to anon, authenticated;
grant execute on function public.sync_pair_create(text) to anon, authenticated;
grant execute on function public.sync_pair_claim(text) to anon, authenticated;
