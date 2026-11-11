-- Awaaz: storage buckets + policies.
--   report-audio  (private)  client uploads to {auth.uid()}/{uuid}.{ext}
--   report-images (public)   client uploads to {uuid}/{n}.jpg ; max 5 MB ; image/*
--   tts-cache     (public)   written only by the service role: {sha256}.mp3

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('report-audio',  'report-audio',  false, 26214400, null),
  ('report-images', 'report-images', true,  5242880,  array['image/*']),
  ('tts-cache',     'tts-cache',     true,  10485760, array['audio/mpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "awaaz report-audio insert own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'report-audio' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "awaaz report-audio select own folder" on storage.objects
  for select to authenticated
  using (bucket_id = 'report-audio' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "awaaz report-images insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'report-images');
