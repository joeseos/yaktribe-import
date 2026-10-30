-- A tiny XenForo 2 forum for test runs: only the tables and columns the import reads,
-- with one of each case it has to handle. Load into an empty MariaDB/MySQL database:
--   mysql xenforo < test/fixtures/xenforo.sql

DROP TABLE IF EXISTS xf_user, xf_node, xf_thread, xf_post, xf_reaction_content, xf_tag, xf_tag_content, xf_thread_prefix, xf_phrase;

CREATE TABLE xf_user (
  user_id int unsigned PRIMARY KEY,
  username varchar(50) NOT NULL,
  email varchar(120) NOT NULL DEFAULT ''
) CHARSET utf8mb4;

CREATE TABLE xf_node (
  node_id int unsigned PRIMARY KEY,
  title varchar(50) NOT NULL,
  node_type_id varbinary(25) NOT NULL,
  parent_node_id int unsigned NOT NULL DEFAULT 0
) CHARSET utf8mb4;

CREATE TABLE xf_thread (
  thread_id int unsigned PRIMARY KEY,
  node_id int unsigned NOT NULL,
  title varchar(150) NOT NULL,
  user_id int unsigned NOT NULL,
  post_date int unsigned NOT NULL,
  sticky tinyint unsigned NOT NULL DEFAULT 0,
  discussion_state enum('visible','moderated','deleted') NOT NULL DEFAULT 'visible',
  discussion_open tinyint unsigned NOT NULL DEFAULT 1,
  discussion_type varchar(50) NOT NULL DEFAULT 'discussion',
  prefix_id int unsigned NOT NULL DEFAULT 0
) CHARSET utf8mb4;

CREATE TABLE xf_post (
  post_id int unsigned PRIMARY KEY,
  thread_id int unsigned NOT NULL,
  user_id int unsigned NOT NULL,
  username varchar(50) NOT NULL,
  post_date int unsigned NOT NULL,
  message mediumtext NOT NULL,
  message_state enum('visible','moderated','deleted') NOT NULL DEFAULT 'visible',
  position int unsigned NOT NULL,
  last_edit_date int unsigned NOT NULL DEFAULT 0
) CHARSET utf8mb4;

CREATE TABLE xf_reaction_content (
  reaction_content_id int unsigned AUTO_INCREMENT PRIMARY KEY,
  reaction_id int unsigned NOT NULL,
  content_type varbinary(25) NOT NULL,
  content_id int unsigned NOT NULL,
  reaction_user_id int unsigned NOT NULL,
  reaction_date int unsigned NOT NULL,
  content_user_id int unsigned NOT NULL
) CHARSET utf8mb4;

CREATE TABLE xf_tag (
  tag_id int unsigned PRIMARY KEY,
  tag varchar(100) NOT NULL
) CHARSET utf8mb4;

CREATE TABLE xf_tag_content (
  tag_content_id int unsigned AUTO_INCREMENT PRIMARY KEY,
  content_type varbinary(25) NOT NULL,
  content_id int unsigned NOT NULL,
  tag_id int unsigned NOT NULL
) CHARSET utf8mb4;

CREATE TABLE xf_thread_prefix (
  prefix_id int unsigned PRIMARY KEY,
  prefix_group_id int unsigned NOT NULL DEFAULT 0
) CHARSET utf8mb4;

CREATE TABLE xf_phrase (
  phrase_id int unsigned AUTO_INCREMENT PRIMARY KEY,
  language_id int unsigned NOT NULL,
  title varbinary(100) NOT NULL,
  phrase_text mediumtext NOT NULL
) CHARSET utf8mb4;

-- Kal's email matches a confirmed Munda Manager account (in another case), Zed's an unconfirmed one.
-- Mira has an account too but is only mentioned, never posts or likes.
INSERT INTO xf_user VALUES
  (1, 'Admin', 'admin@yak.test'),
  (2, 'Bob', 'bob@yak.test'),
  (45, 'Kal', 'KAL@Example.com'),
  (46, 'Zed', 'zed@example.com'),
  (47, 'Mira', 'mira@example.com');

INSERT INTO xf_node VALUES
  (1, 'Necromunda', 'Category', 0),
  (2, 'Gang discussion', 'Forum', 1),
  (3, 'Battle reports', 'Forum', 1),
  (4, 'Off topic', 'Forum', 1);

INSERT INTO xf_thread VALUES
  (7, 3, 'First blood: Goliaths vs Eschers', 2, 1600000000, 1, 'visible', 1, 'discussion', 1),
  (8, 2, 'Campaign   ideas', 45, 1600100000, 0, 'visible', 0, 'discussion', 0),
  (9, 2, 'Deleted thread', 2, 1600200000, 0, 'deleted', 1, 'discussion', 0),
  (10, 2, 'Moved: First blood', 2, 1600300000, 0, 'visible', 1, 'redirect', 0),
  (11, 4, 'Off topic, not mapped', 2, 1600400000, 0, 'visible', 1, 'discussion', 0),
  (12, 2, 'Only a deleted post', 2, 1600500000, 0, 'visible', 1, 'discussion', 0),
  (13, 2, CONCAT('Long post and guests ', REPEAT('x', 120)), 0, 1600600000, 0, 'visible', 1, 'discussion', 2);

INSERT INTO xf_post VALUES
  (10, 7, 2, 'Bob', 1600000000, '[B]Turn 1[/B]\nMy Goliaths charged.\n\n[IMG]https://i.imgur.com/a.png[/IMG]', 'visible', 0, 0),
  (11, 7, 45, 'Kal', 1600000500,
    '[QUOTE="Bob, post: 10, member: 2"]My Goliaths charged.[/QUOTE]\nNice one [USER=2]@Bob[/USER], ask [USER=46]@Zed[/USER].\n[ATTACH type="full"]5[/ATTACH]\nSee [URL=https://yaktribe.games/community/threads/campaign-ideas.8/]the campaign thread[/URL].',
    'visible', 1, 1600000900),
  (12, 7, 46, 'Zed', 1600000600, 'Waiting for approval', 'moderated', 2, 0),
  (20, 8, 45, 'Kal', 1600100000, '[LIST]\n[*]Territories\n[*]Skills\n[/LIST]', 'visible', 0, 0),
  (21, 8, 1, 'Admin', 1600100100, 'Like this report: https://yaktribe.games/community/posts/11/ cc [USER=47]@Mira[/USER]', 'visible', 1, 0),
  (30, 12, 2, 'Bob', 1600500000, 'Deleted', 'deleted', 0, 0),
  (40, 13, 0, 'Visitor', 1600600000, 'Posted as a guest', 'visible', 0, 0),
  (41, 13, 99, 'Gone', 1600600100, 'My account was deleted', 'visible', 1, 0),
  (42, 13, 2, 'Bob', 1600600200, CONCAT('[B]Big[/B] ', REPEAT('[i]word[/i] ', 12000)), 'visible', 2, 0),
  (50, 11, 2, 'Bob', 1600400000, 'Not imported', 'visible', 0, 0);

INSERT INTO xf_reaction_content (reaction_id, content_type, content_id, reaction_user_id, reaction_date, content_user_id) VALUES
  (1, 'post', 10, 45, 1600001000, 2),  -- matched liker
  (1, 'post', 10, 46, 1600001100, 2),  -- liker without a Munda Manager account
  (1, 'post', 10, 2, 1600001200, 2),   -- own post
  (2, 'post', 10, 1, 1600001300, 2),   -- Love, not a Like
  (1, 'post', 20, 99, 1600101000, 45); -- liker account deleted

INSERT INTO xf_tag VALUES (1, 'campaign'), (2, 'scenery');
INSERT INTO xf_tag_content (content_type, content_id, tag_id) VALUES ('thread', 8, 1), ('thread', 7, 2);

INSERT INTO xf_thread_prefix VALUES (1, 0), (2, 0);
INSERT INTO xf_phrase (language_id, title, phrase_text) VALUES
  (0, 'thread_prefix.1', 'Battle Report'),
  (0, 'thread_prefix.2', 'Question');
