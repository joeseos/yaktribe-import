-- Tables the import writes besides the forum's own. Safe to run again.
--
-- public.forum_imported_authors and the imported_author_id columns are what the
-- app will read to show "<name> (YakTribe)" on posts nobody has claimed yet, so a
-- Munda Manager migration has to add them before the production import.
-- Everything else lives in the yaktribe schema, which the app never reads.

CREATE TABLE IF NOT EXISTS public.forum_imported_authors (
  id uuid PRIMARY KEY,
  xf_user_id integer UNIQUE,
  username text NOT NULL,
  profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.forum_imported_authors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read imported authors" ON public.forum_imported_authors;
CREATE POLICY "Anyone can read imported authors" ON public.forum_imported_authors
  FOR SELECT TO anon, authenticated USING (true);

GRANT SELECT ON public.forum_imported_authors TO anon, authenticated;

-- Checked first because ALTER TABLE locks the forum against reads even when the column exists
DO $$
DECLARE
  forum_table text;
BEGIN
  FOREACH forum_table IN ARRAY ARRAY['forum_threads', 'forum_posts'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = forum_table AND column_name = 'imported_author_id'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD COLUMN imported_author_id uuid REFERENCES public.forum_imported_authors(id) ON DELETE SET NULL',
        forum_table
      );
    END IF;
  END LOOP;
END $$;

CREATE SCHEMA IF NOT EXISTS yaktribe;
REVOKE ALL ON SCHEMA yaktribe FROM PUBLIC;

-- Email hashes for claiming: sha256 of the trimmed, lower-cased address
CREATE TABLE IF NOT EXISTS yaktribe.author_emails (
  author_id uuid PRIMARY KEY REFERENCES public.forum_imported_authors(id) ON DELETE CASCADE,
  email_sha256 text NOT NULL
);
CREATE INDEX IF NOT EXISTS author_emails_hash_idx ON yaktribe.author_emails (email_sha256);

-- Old XenForo ids, for rewriting links now and 301s from YakTribe later
CREATE TABLE IF NOT EXISTS yaktribe.thread_map (
  xf_thread_id integer PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES public.forum_threads(id) ON DELETE CASCADE,
  path text NOT NULL
);

CREATE TABLE IF NOT EXISTS yaktribe.post_map (
  xf_post_id integer PRIMARY KEY,
  post_id uuid NOT NULL,
  xf_thread_id integer NOT NULL,
  post_number integer NOT NULL
);

-- Likes by people who haven't claimed their posts yet; they become forum_post_likes rows on claim.
-- forum_posts.like_count already counts them, so the claim must not let the like trigger count them again.
CREATE TABLE IF NOT EXISTS yaktribe.pending_likes (
  post_id uuid NOT NULL REFERENCES public.forum_posts(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES public.forum_imported_authors(id) ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL,
  PRIMARY KEY (post_id, author_id)
);
