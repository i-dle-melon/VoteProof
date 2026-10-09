-- Operator-reviewed Supabase Postgres hook, NOT a D1 migration.
-- Do not execute on hosted projects without separate authorization.
create or replace function public.voteproof_signup_policy(event jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  -- Require actual JSON booleans. Missing/malformed events fail closed.
  if event #> '{user,is_anonymous}' = 'false'::jsonb
     and (
       event #>> '{user,app_metadata,provider}' = 'google'
       or (
         event #>> '{user,app_metadata,provider}' = 'email'
         and event #> '{user,app_metadata,voteproof_verified_signup}' = 'true'::jsonb
       )
     ) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403, 'message', 'Use the application registration flow'));
end;
$$;
revoke execute on function public.voteproof_signup_policy(jsonb) from public, anon, authenticated;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.voteproof_signup_policy(jsonb) to supabase_auth_admin;
