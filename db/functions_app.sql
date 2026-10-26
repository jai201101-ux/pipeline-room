-- Called from the app by the signed-in VP. Each checks the caller is a lead.
create or replace function room_mark_done(p_event bigint) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_lead() then raise exception 'Only the VP can do this'; end if;
  update events set data = coalesce(data, '{}'::jsonb) || jsonb_build_object('done', true, 'done_by', my_name(), 'done_at', now()) where id = p_event and type = 'ask_mark';
end $$;
revoke all on function room_mark_done(bigint) from public, anon;
grant execute on function room_mark_done(bigint) to authenticated;
notify pgrst, 'reload schema';
