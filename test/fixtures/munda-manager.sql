-- Munda Manager data for test runs against test/fixtures/xenforo.sql: three accounts and one
-- thread of the app's own, which the import must leave alone. Load after the Munda Manager schema.

INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-000000000045', 'kal@example.com', now(), '{"username": "Kal_MM"}'),
  ('00000000-0000-4000-8000-000000000046', 'zed@example.com', NULL, '{"username": "Zed_MM"}'),
  ('00000000-0000-4000-8000-000000000047', 'mira@example.com', now(), '{"username": "Mira_MM"}');

INSERT INTO forum_categories (id, slug, name, position)
VALUES ('00000000-0000-4000-8000-0000000000c1', 'general', 'General', 1);

ALTER TABLE forum_threads DISABLE TRIGGER USER;
ALTER TABLE forum_posts DISABLE TRIGGER USER;
INSERT INTO forum_threads (id, number, category_id, title, author_id, post_count)
OVERRIDING SYSTEM VALUE
VALUES ('00000000-0000-4000-8000-0000000000a1', 5000, '00000000-0000-4000-8000-0000000000c1', 'Welcome', '00000000-0000-4000-8000-000000000045', 1);
INSERT INTO forum_posts (thread_id, post_number, author_id, content)
VALUES ('00000000-0000-4000-8000-0000000000a1', 1, '00000000-0000-4000-8000-000000000045', '<p>Hello</p>');
ALTER TABLE forum_threads ENABLE TRIGGER USER;
ALTER TABLE forum_posts ENABLE TRIGGER USER;
