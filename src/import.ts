import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { Client } from 'pg';
import { collectRefs, emptyRefs, escapeHtml, imageHtml, parse, render, type Image, type Resolver } from './bbcode.ts';
import type { Mapping } from './mapping.ts';
import { Progress } from './progress.ts';
import type { ImageFile, Report, StepReport } from './report.ts';

export interface ImportOptions {
  /** XenForo's table prefix, xf_ unless the install changed it */
  prefix: string;
  /** Threads per batch */
  batchSize: number;
  /** Import only the first N threads, for quick test runs */
  limitThreads: number | null;
  /** Public URL of the bucket the images are copied to; null shows a placeholder instead */
  imageBaseUrl: string | null;
}

// Munda Manager's own limits, from the forum migrations
const POSTS_PER_PAGE = 20;
const MAX_CONTENT = 50_000;
const MAX_TITLE = 150;
const LIKE_REACTION_ID = 1;
const MAX_TAGS = 3;
// Posts per insert: thread batches can hold megathreads, so posts are paged on their own
const POST_BATCH = 2000;
// Tables whose forum triggers would overwrite dates, numbers and counters, or rate-limit the import
const TRIGGER_TABLES = ['forum_threads', 'forum_posts', 'forum_post_likes'];

interface ThreadInfo {
  id: string;
  path: string;
  nodeId: number;
  prefixId: number;
}

interface Author {
  id: string;
  profileId: string | null;
}

// xf_attachment_data columns for the image manifest
const IMAGE_COLUMNS = 'a.attachment_id, d.data_id, d.filename, d.file_size, d.file_hash, d.file_path, d.xfa_url';
interface ImageRow {
  attachment_id: number;
  data_id: number;
  filename: string;
  file_size: number;
  file_hash: string;
  file_path: string;
  xfa_url: string;
}

/** Where XenForo keeps the full-size file, relative to its install folder (XenForo's default unless file_path says otherwise). */
export function attachmentFilePath(row: Pick<ImageRow, 'data_id' | 'file_hash' | 'file_path'>): string {
  const placeholders: Record<string, string> = {
    '%INTERNAL%': 'internal_data', '%DATA%': 'data', '%DATA_ID%': String(row.data_id),
    '%FLOOR%': String(Math.floor(row.data_id / 1000)), '%HASH%': row.file_hash,
  };
  return (row.file_path || '%INTERNAL%/attachments/%FLOOR%/%DATA_ID%-%HASH%.data').replace(/%[A-Z_]+%/g, (key) => placeholders[key] ?? key);
}

/** Same as slugifyHeading in Munda Manager, which builds forum thread URLs. */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

/** Same as forumPostHref in Munda Manager: the page a post is on, scrolled to it. */
export function postHref(threadPath: string, postNumber: number): string {
  const page = Math.ceil(postNumber / POSTS_PER_PAGE);
  return `${page === 1 ? threadPath : `${threadPath}/page/${page}`}#post-${postNumber}`;
}

export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

const fromUnix = (seconds: number) => new Date(seconds * 1000);

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function skip(step: StepReport, reason: string, count = 1) {
  if (count) step.skipped[reason] = (step.skipped[reason] ?? 0) + count;
}

/** Inserts rows as one statement, one array parameter per column. */
async function insertRows(
  pg: Client,
  table: string,
  columns: [name: string, type: string][],
  rows: unknown[][],
  { overriding = false, onConflict = '' } = {},
) {
  if (!rows.length) return 0;
  const arrays = columns.map((_, i) => rows.map((row) => row[i]));
  const unnest = columns.map(([, type], i) => `$${i + 1}::${type}[]`).join(', ');
  const result = await pg.query(
    `INSERT INTO ${table} (${columns.map(([name]) => name).join(', ')})
     ${overriding ? 'OVERRIDING SYSTEM VALUE' : ''}
     SELECT * FROM unnest(${unnest}) ${onConflict}`,
    arrays,
  );
  return result.rowCount ?? 0;
}

export class Importer {
  private readonly xf: Connection;
  private readonly pg: Client;
  private readonly mapping: Mapping;
  private readonly report: Report;
  private readonly options: ImportOptions;

  private readonly categoryIds = new Map<string, string>();
  private readonly threads = new Map<number, ThreadInfo>();
  private readonly authors = new Map<number, Author>();
  private readonly guests = new Map<string, string>();
  /** Profiles of mentioned users who neither posted nor liked in the imported threads */
  private readonly mentioned = new Map<number, string | null>();
  /** The image manifest: every attachment and gallery image the imported posts show, by attachment id */
  readonly images = new Map<number, ImageFile>();

  constructor(xf: Connection, pg: Client, mapping: Mapping, report: Report, options: ImportOptions) {
    this.xf = xf;
    this.pg = pg;
    this.mapping = mapping;
    this.report = report;
    this.options = options;
  }

  private t(name: string): string {
    return `${this.options.prefix}${name}`;
  }

  private async xfRows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.xf.query<RowDataPacket[]>(sql, params);
    return rows as T[];
  }

  private threadChunks(): number[][] {
    return chunks([...this.threads.keys()], this.options.batchSize);
  }

  /** Runs every step in one transaction: a failure, or a dry run, leaves Munda Manager as it was. */
  async run(dryRun: boolean) {
    await this.pg.query('BEGIN');
    try {
      await this.pg.query(readFileSync(new URL('../sql/import-schema.sql', import.meta.url), 'utf8'));
      for (const table of TRIGGER_TABLES) await this.pg.query(`ALTER TABLE public.${table} DISABLE TRIGGER USER`);

      await this.checkForums();
      await this.ensureCategories();
      await this.removePreviousImport();
      await this.importThreads();
      await this.mapPosts();
      await this.importAuthors();
      await this.importPosts();
      await this.importLikes();
      await this.importTags();
      await this.recount();

      for (const table of TRIGGER_TABLES) await this.pg.query(`ALTER TABLE public.${table} ENABLE TRIGGER USER`);
      if (dryRun) {
        await this.rollback();
      } else {
        await this.pg.query('COMMIT');
        this.report.committed = true;
      }
    } catch (error) {
      await this.rollback().catch(() => {});
      throw error;
    }
  }

  /** Sequences ignore rollbacks, so hand back the thread numbers a dry or failed run took. */
  private async rollback() {
    await this.pg.query('ROLLBACK');
    await this.pg.query(`
      SELECT setval(pg_get_serial_sequence('public.forum_threads', 'number'), greatest(max(number), 1))
      FROM forum_threads`);
  }

  private async checkForums() {
    const ids = [...this.mapping.forums.keys()];
    const nodes = await this.xfRows<{ node_id: number; node_type_id: string | Buffer }>(
      `SELECT node_id, node_type_id FROM ${this.t('node')} WHERE node_id IN (?)`,
      [ids],
    );
    const found = new Map(nodes.map((node) => [node.node_id, String(node.node_type_id)]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`The mapping lists forums XenForo doesn't have: ${missing.join(', ')}`);
    const notForums = ids.filter((id) => found.get(id) !== 'Forum');
    if (notForums.length) throw new Error(`The mapping lists nodes that aren't forums (categories, links or pages): ${notForums.join(', ')}`);

    const unmapped = await this.xfRows<{ node_id: number; title: string; n: number }>(
      `SELECT n.node_id, n.title, COUNT(*) AS n FROM ${this.t('node')} n
       JOIN ${this.t('thread')} t ON t.node_id = n.node_id AND t.discussion_state = 'visible'
       WHERE n.node_type_id = 'Forum' AND n.node_id NOT IN (?) GROUP BY n.node_id, n.title ORDER BY n DESC`,
      [ids],
    );
    if (unmapped.length) {
      this.report.notes.push(`Forums not in the mapping, left out: ${unmapped.map((forum) => `"${forum.title}" (${forum.node_id}) ×${forum.n}`).join(', ')}.`);
    }
  }

  private async ensureCategories() {
    const slugs = [...new Set([...this.mapping.forums.values()].map((forum) => forum.category))];
    const { rows } = await this.pg.query<{ id: string; slug: string }>(
      'SELECT id, slug FROM forum_categories WHERE slug = ANY($1)',
      [slugs],
    );
    for (const row of rows) this.categoryIds.set(row.slug, row.id);
    for (const slug of slugs.filter((slug) => !this.categoryIds.has(slug))) {
      const name = this.mapping.categoryNames.get(slug) ?? slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
      const { rows: created } = await this.pg.query<{ id: string }>(
        `INSERT INTO forum_categories (slug, name, position)
         VALUES ($1, $2, (SELECT coalesce(max(position), 0) + 1 FROM forum_categories)) RETURNING id`,
        [slug, name],
      );
      this.categoryIds.set(slug, created[0].id);
      this.report.notes.push(`Created the category "${slug}" (named "${name}"), which didn't exist yet. Rename it in the app if needed.`);
    }
  }

  private async removePreviousImport() {
    const { rows: [{ count: newPosts }] } = await this.pg.query<{ count: string }>(
      `SELECT count(*) FROM forum_posts p JOIN yaktribe.thread_map m ON m.thread_id = p.thread_id
       WHERE p.id NOT IN (SELECT post_id FROM yaktribe.post_map)`,
    );
    if (Number(newPosts)) {
      throw new Error(
        `Replies written in Munda Manager since the last import (${newPosts}) are in imported threads. ` +
          'Running the import again would delete them, so it stopped.',
      );
    }
    const { rowCount } = await this.pg.query('DELETE FROM forum_threads WHERE id IN (SELECT thread_id FROM yaktribe.thread_map)');
    await this.pg.query('TRUNCATE yaktribe.post_map');
    await this.pg.query('DELETE FROM forum_imported_authors');
    if (rowCount) this.report.notes.push(`Removed ${rowCount.toLocaleString('en-US')} threads from the previous import first.`);
  }

  private async importThreads() {
    const step = this.report.step('Threads');
    const forumIds = [...this.mapping.forums.keys()];
    const hasPosts = `EXISTS (SELECT 1 FROM ${this.t('post')} p WHERE p.thread_id = t.thread_id AND p.message_state = 'visible')`;
    const where = `t.node_id IN (?) AND t.discussion_state = 'visible' AND t.discussion_type <> 'redirect' AND ${hasPosts}`;

    const states = await this.xfRows<{ discussion_state: string; discussion_type: string; has_posts: number; n: number }>(
      `SELECT discussion_state, discussion_type, ${hasPosts} AS has_posts, COUNT(*) AS n FROM ${this.t('thread')} t
       WHERE t.node_id IN (?) GROUP BY discussion_state, discussion_type, has_posts`,
      [forumIds],
    );
    let total = 0;
    for (const { discussion_state: state, discussion_type: type, has_posts: hasVisiblePosts, n } of states) {
      if (state !== 'visible') skip(step, `${state} on YakTribe`, Number(n));
      else if (type === 'redirect') skip(step, 'redirect to a moved thread', Number(n));
      else if (!hasVisiblePosts) skip(step, 'no visible posts', Number(n));
      else total += Number(n);
    }
    if (this.options.limitThreads !== null && total > this.options.limitThreads) {
      skip(step, 'over --limit-threads', total - this.options.limitThreads);
      total = this.options.limitThreads;
    }

    const progress = new Progress('Threads', total);
    let lastId = 0;
    while (step.read < total) {
      const batch = await this.xfRows<{
        thread_id: number; node_id: number; title: string; post_date: number; sticky: number; discussion_open: number; prefix_id: number;
      }>(
        `SELECT thread_id, node_id, title, post_date, sticky, discussion_open, prefix_id FROM ${this.t('thread')} t
         WHERE ${where} AND t.thread_id > ? ORDER BY t.thread_id LIMIT ?`,
        [forumIds, lastId, Math.min(this.options.batchSize, total - step.read)],
      );
      if (!batch.length) break;
      lastId = batch[batch.length - 1].thread_id;
      step.read += batch.length;

      // Numbers from the app's own sequence, taken up front so each thread's path is known and they follow YakTribe's order
      const { rows: numbers } = await this.pg.query<{ number: string }>(
        `SELECT nextval(pg_get_serial_sequence('public.forum_threads', 'number')) AS number FROM generate_series(1, $1)`,
        [batch.length],
      );
      const rows = batch.map((thread, i) => {
        const number = Number(numbers[i].number);
        const forum = this.mapping.forums.get(thread.node_id)!;
        let title = thread.title.replace(/\s+/g, ' ').trim() || '(untitled)';
        if (title.length > MAX_TITLE) title = title.slice(0, MAX_TITLE).trim();
        const info: ThreadInfo = {
          id: randomUUID(),
          path: `/forum/${forum.category}/${number}-${slugify(title)}`,
          nodeId: thread.node_id,
          prefixId: thread.prefix_id,
        };
        this.threads.set(thread.thread_id, info);
        const created = fromUnix(thread.post_date);
        return [info.id, number, this.categoryIds.get(forum.category), title, thread.sticky === 1, thread.discussion_open === 0, created, created];
      });
      step.written += await insertRows(
        this.pg,
        'forum_threads',
        [['id', 'uuid'], ['number', 'bigint'], ['category_id', 'uuid'], ['title', 'text'], ['is_pinned', 'boolean'],
          ['is_locked', 'boolean'], ['created_at', 'timestamptz'], ['last_post_at', 'timestamptz']],
        rows,
        { overriding: true },
      );
      await insertRows(
        this.pg,
        'yaktribe.thread_map',
        [['xf_thread_id', 'integer'], ['thread_id', 'uuid'], ['path', 'text']],
        batch.map((thread) => {
          const info = this.threads.get(thread.thread_id)!;
          return [thread.thread_id, info.id, info.path];
        }),
      );
      progress.tick(batch.length);
    }
    progress.finish();
  }

  /** Numbers every visible post first, so quotes and links can point at posts in any thread. */
  private async mapPosts() {
    const step = this.report.step('Post numbers');
    const progress = new Progress('Numbering', this.threads.size);
    for (const threadIds of this.threadChunks()) {
      const states = await this.xfRows<{ message_state: string; n: number }>(
        `SELECT message_state, COUNT(*) AS n FROM ${this.t('post')} WHERE thread_id IN (?) GROUP BY message_state`,
        [threadIds],
      );
      for (const { message_state: state, n } of states) {
        if (state !== 'visible') skip(step, `${state} on YakTribe`, Number(n));
      }
      const posts = await this.xfRows<{ post_id: number; thread_id: number; n: number }>(
        `SELECT post_id, thread_id, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY position, post_date, post_id) AS n
         FROM ${this.t('post')} WHERE thread_id IN (?) AND message_state = 'visible'`,
        [threadIds],
      );
      step.read += posts.length;
      step.written += await insertRows(
        this.pg,
        'yaktribe.post_map',
        [['xf_post_id', 'integer'], ['post_id', 'uuid'], ['xf_thread_id', 'integer'], ['post_number', 'integer']],
        posts.map((post) => [post.post_id, randomUUID(), post.thread_id, Number(post.n)]),
      );
      progress.tick(threadIds.length);
    }
    progress.finish();
  }

  /** Everyone who wrote or liked an imported post, linked to a Munda Manager account when a confirmed email matches. */
  private async importAuthors() {
    const step = this.report.step('Authors');
    const userIds = new Set<number>();
    for (const threadIds of this.threadChunks()) {
      const rows = await this.xfRows<{ user_id: number }>(
        `SELECT DISTINCT user_id FROM ${this.t('post')} WHERE thread_id IN (?) AND message_state = 'visible' AND user_id > 0
         UNION
         SELECT DISTINCT r.reaction_user_id FROM ${this.t('reaction_content')} r
         JOIN ${this.t('post')} p ON p.post_id = r.content_id
         WHERE r.content_type = 'post' AND r.reaction_id = ? AND p.thread_id IN (?) AND p.message_state = 'visible'`,
        [threadIds, LIKE_REACTION_ID, threadIds],
      );
      for (const row of rows) userIds.add(row.user_id);
    }

    const progress = new Progress('Authors', userIds.size);
    let matched = 0;
    for (const ids of chunks([...userIds], 1000)) {
      const users = await this.xfRows<{ user_id: number; username: string; email: string }>(
        `SELECT user_id, username, email FROM ${this.t('user')} WHERE user_id IN (?)`,
        [ids],
      );
      step.read += users.length;
      skip(step, 'account deleted on YakTribe (posts keep the name they were written under)', ids.length - users.length);

      const profiles = await this.matchProfiles(users);
      const rows = users.map((user) => {
        const profileId = profiles.get(user.user_id) ?? null;
        if (profileId) matched++;
        const author = { id: randomUUID(), profileId };
        this.authors.set(user.user_id, author);
        return [author.id, user.user_id, user.username, profileId];
      });
      step.written += await insertRows(
        this.pg,
        'forum_imported_authors',
        [['id', 'uuid'], ['xf_user_id', 'integer'], ['username', 'text'], ['profile_id', 'uuid']],
        rows,
      );
      await insertRows(
        this.pg,
        'yaktribe.author_emails',
        [['author_id', 'uuid'], ['email_sha256', 'text']],
        users.filter((user) => user.email.trim()).map((user) => [this.authors.get(user.user_id)!.id, hashEmail(user.email)]),
      );
      progress.tick(ids.length);
    }
    progress.finish();
    this.report.notes.push(
      `${matched.toLocaleString('en-US')} of ${this.authors.size.toLocaleString('en-US')} YakTribe authors matched a confirmed Munda Manager account by email.`,
    );
  }

  /** Munda Manager profiles by XenForo user id, for users whose email matches a confirmed account. */
  private async matchProfiles(users: { user_id: number; email: string }[]): Promise<Map<number, string>> {
    const email = (user: { email: string }) => user.email.trim().toLowerCase();
    const { rows } = await this.pg.query<{ id: string; email: string }>(
      `SELECT u.id, lower(u.email) AS email FROM auth.users u JOIN profiles p ON p.id = u.id
       WHERE u.email_confirmed_at IS NOT NULL AND lower(u.email) = ANY($1)`,
      [users.map(email).filter(Boolean)],
    );
    const byEmail = new Map(rows.map((row) => [row.email, row.id]));
    return new Map(users.flatMap((user) => (byEmail.has(email(user)) ? [[user.user_id, byEmail.get(email(user))!]] : [])));
  }

  /** A post by a guest or a deleted account: an author with the name it was posted under. */
  private async guestAuthor(username: string): Promise<string> {
    const name = username.trim() || 'Guest';
    const key = name.toLowerCase();
    let id = this.guests.get(key);
    if (!id) {
      id = randomUUID();
      this.guests.set(key, id);
      await this.pg.query('INSERT INTO forum_imported_authors (id, username) VALUES ($1, $2)', [id, name]);
    }
    return id;
  }

  /** An image for the bucket: listed in the manifest, shown from `<imageBaseUrl>/attachments/<attachment id>.webp`. */
  private image(row: ImageRow, sourceUrl: string): Image {
    const name = `attachments/${row.attachment_id}.webp`;
    if (!this.images.has(row.attachment_id)) {
      this.images.set(row.attachment_id, {
        name, sourceUrl, filePath: attachmentFilePath(row), externalUrl: row.xfa_url, fileSize: row.file_size, filename: row.filename,
      });
    }
    return { src: this.options.imageBaseUrl ? `${this.options.imageBaseUrl}/${name}` : null };
  }

  /** Images attached to imported posts (shown inline or below the post) and the public gallery images posts embed. */
  private async imagesFor(postIds: number[], attachmentIds: number[], mediaIds: number[]) {
    const attachments = await this.xfRows<ImageRow & { post_id: number; thread_id: number }>(
      `SELECT ${IMAGE_COLUMNS}, a.content_id AS post_id, p.thread_id FROM ${this.t('attachment')} a
       JOIN ${this.t('attachment_data')} d ON d.data_id = a.data_id
       JOIN ${this.t('post')} p ON p.post_id = a.content_id AND p.message_state = 'visible'
       WHERE a.content_type = 'post' AND d.width > 0 AND (a.content_id IN (?) OR a.attachment_id IN (?))
       ORDER BY a.attachment_id`,
      [postIds, attachmentIds.length ? attachmentIds : [0]],
    );
    // An image from a post that isn't imported (a private forum, say) stays out, even when quoted
    const imported = attachments.filter((row) => this.threads.has(row.thread_id));
    const media = mediaIds.length
      ? await this.xfRows<ImageRow & { media_id: number }>(
        `SELECT ${IMAGE_COLUMNS}, m.media_id FROM ${this.t('mg_media_item')} m
         JOIN ${this.t('attachment')} a ON a.content_type = 'xfmg_media' AND a.content_id = m.media_id
         JOIN ${this.t('attachment_data')} d ON d.data_id = a.data_id
         LEFT JOIN ${this.t('mg_album')} al ON al.album_id = m.album_id
         WHERE m.media_id IN (?) AND m.media_state = 'visible' AND m.media_type = 'image' AND d.width > 0
           AND (m.album_id = 0 OR (al.album_state = 'visible' AND al.view_privacy IN ('public', 'inherit')))
         ORDER BY a.attachment_id`,
        [mediaIds],
      )
      : [];
    const byPost = new Map<number, number[]>();
    for (const row of imported) byPost.set(row.post_id, [...(byPost.get(row.post_id) ?? []), row.attachment_id]);
    // An item's file is its first attachment
    const byMedia = new Map<number, ImageRow>();
    for (const row of media) if (!byMedia.has(row.media_id)) byMedia.set(row.media_id, row);
    return { attachments: new Map(imported.map((row) => [row.attachment_id, row])), media: byMedia, byPost };
  }

  private async resolverFor(refsByPost: ReturnType<typeof emptyRefs>[], postIds: number[]) {
    const refs = emptyRefs();
    for (const postRefs of refsByPost) {
      for (const key of Object.keys(refs) as (keyof typeof refs)[]) for (const id of postRefs[key]) refs[key].add(id);
    }
    const { rows: posts } = await this.pg.query<{ xf_post_id: number; path: string; post_number: number }>(
      `SELECT pm.xf_post_id, tm.path, pm.post_number FROM yaktribe.post_map pm
       JOIN yaktribe.thread_map tm ON tm.xf_thread_id = pm.xf_thread_id WHERE pm.xf_post_id = ANY($1)`,
      [[...refs.postIds]],
    );
    const postHrefs = new Map(posts.map((post) => [post.xf_post_id, postHref(post.path, post.post_number)]));

    const unknown = [...refs.userIds].filter((id) => !this.authors.has(id) && !this.mentioned.has(id));
    if (unknown.length) {
      const users = await this.xfRows<{ user_id: number; email: string }>(
        `SELECT user_id, email FROM ${this.t('user')} WHERE user_id IN (?)`,
        [unknown],
      );
      const profiles = await this.matchProfiles(users);
      for (const id of unknown) this.mentioned.set(id, profiles.get(id) ?? null);
    }
    const images = await this.imagesFor(postIds, [...refs.attachmentIds], [...refs.mediaIds]);
    const resolver: Resolver = {
      postHref: (id) => postHrefs.get(id) ?? null,
      threadHref: (id) => this.threads.get(id)?.path ?? null,
      mention: (id) => {
        const profileId = this.authors.has(id) ? this.authors.get(id)!.profileId : this.mentioned.get(id);
        return profileId ? { profileId } : null;
      },
      attachment: (id) => {
        const row = images.attachments.get(id);
        return row ? this.image(row, `https://yaktribe.games/community/attachments/${id}/`) : null;
      },
      galleryMedia: (id) => {
        const row = images.media.get(id);
        return row ? this.image(row, `https://yaktribe.games/community/media/${id}/full`) : null;
      },
    };
    return { resolver, attachmentsByPost: images.byPost };
  }

  private async importPosts() {
    const step = this.report.step('Posts');
    const { rows: [{ count }] } = await this.pg.query<{ count: string }>('SELECT count(*) FROM yaktribe.post_map');
    const progress = new Progress('Posts', Number(count));
    let pollCount = 0;
    for (const threadIds of this.threadChunks()) {
      const polls = await this.pollsFor(threadIds);
      pollCount += polls.size;
      for (let lastId = 0; ; ) {
        const posts = await this.xfRows<{
          post_id: number; thread_id: number; user_id: number; username: string; post_date: number; message: string; last_edit_date: number;
        }>(
          `SELECT post_id, thread_id, user_id, username, post_date, message, last_edit_date FROM ${this.t('post')}
           WHERE thread_id IN (?) AND message_state = 'visible' AND post_id > ? ORDER BY post_id LIMIT ?`,
          [threadIds, lastId, POST_BATCH],
        );
        if (!posts.length) break;
        lastId = posts[posts.length - 1].post_id;
        step.read += posts.length;
        const { rows: mapped } = await this.pg.query<{ xf_post_id: number; post_id: string; post_number: number }>(
          'SELECT xf_post_id, post_id, post_number FROM yaktribe.post_map WHERE xf_post_id = ANY($1)',
          [posts.map((post) => post.post_id)],
        );
        const numbers = new Map(mapped.map((row) => [row.xf_post_id, row]));

        const parsed = posts.map((post) => parse(post.message, this.report.conversion));
        const refs = parsed.map((nodes) => collectRefs(nodes));
        const { resolver, attachmentsByPost } = await this.resolverFor(refs, posts.map((post) => post.post_id));
        const rows: unknown[][] = [];
        for (const [i, post] of posts.entries()) {
          const target = numbers.get(post.post_id)!;
          const author = post.user_id > 0 ? this.authors.get(post.user_id) : undefined;
          const importedAuthorId = author?.id ?? (await this.guestAuthor(post.username));
          const poll = target.post_number === 1 ? (polls.get(post.thread_id) ?? '') : '';
          let content = render(parsed[i], resolver, this.report.conversion);
          // Images attached but not placed in the text, which XenForo shows below the post
          for (const attachmentId of attachmentsByPost.get(post.post_id) ?? []) {
            if (refs[i].attachmentIds.has(attachmentId)) continue;
            content += `<p>${imageHtml(resolver.attachment(attachmentId)!)}</p>`;
            this.report.conversion.imagesLinked++;
          }
          if (content.length + poll.length > MAX_CONTENT) {
            this.report.truncatedPosts.push(post.post_id);
            content = truncated(post.message, MAX_CONTENT - poll.length);
          }
          content += poll;
          rows.push([
            target.post_id, this.threads.get(post.thread_id)!.id, target.post_number, author?.profileId ?? null, importedAuthorId,
            content, fromUnix(post.post_date), post.last_edit_date > 0 ? fromUnix(post.last_edit_date) : null,
          ]);
        }
        step.written += await insertRows(
          this.pg,
          'forum_posts',
          [['id', 'uuid'], ['thread_id', 'uuid'], ['post_number', 'integer'], ['author_id', 'uuid'], ['imported_author_id', 'uuid'],
            ['content', 'text'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz']],
          rows,
        );
        progress.tick(posts.length);
      }
    }
    progress.finish();
    if (pollCount) this.report.notes.push(`Polls kept as text at the end of their thread's opening post: ${pollCount.toLocaleString('en-US')}.`);
    const megabytes = [...this.images.values()].reduce((sum, image) => sum + Number(image.fileSize), 0) / 1024 ** 2;
    this.report.notes.push(
      `Images for the bucket: ${this.images.size.toLocaleString('en-US')} files, ${Math.round(megabytes).toLocaleString('en-US')} MB before WebP (listed in the images CSV).`
      + (this.options.imageBaseUrl ? '' : ' IMAGE_BASE_URL is not set, so posts show [image] where they will be.'),
    );
  }

  /** Munda Manager has no polls, so each thread's poll becomes its final results, as HTML for the opening post. */
  private async pollsFor(threadIds: number[]): Promise<Map<number, string>> {
    const rows = await this.xfRows<{ thread_id: number; question: string; voter_count: number; response: string; votes: number }>(
      `SELECT p.content_id AS thread_id, p.question, p.voter_count, r.response, r.response_vote_count AS votes
       FROM ${this.t('poll')} p JOIN ${this.t('poll_response')} r ON r.poll_id = p.poll_id
       WHERE p.content_type = 'thread' AND p.content_id IN (?) ORDER BY p.content_id, r.poll_response_id`,
      [threadIds],
    );
    const count = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
    const polls = new Map<number, { question: string; voters: number; items: string[] }>();
    for (const row of rows) {
      const poll = polls.get(row.thread_id) ?? { question: row.question, voters: row.voter_count, items: [] };
      poll.items.push(`<li><p>${escapeHtml(row.response)}: ${count(row.votes, 'vote')}</p></li>`);
      polls.set(row.thread_id, poll);
    }
    return new Map(
      [...polls].map(([threadId, poll]) => [
        threadId,
        `<p><strong>Poll: ${escapeHtml(poll.question)}</strong></p><ul>${poll.items.join('')}</ul><p>${count(poll.voters, 'voter')}</p>`,
      ]),
    );
  }

  private async importLikes() {
    const step = this.report.step('Likes');
    const progress = new Progress('Likes', this.threads.size);
    for (const threadIds of this.threadChunks()) {
      const reactions = await this.xfRows<{ content_id: number; reaction_id: number; reaction_user_id: number; reaction_date: number; post_user_id: number }>(
        `SELECT r.content_id, r.reaction_id, r.reaction_user_id, r.reaction_date, p.user_id AS post_user_id
         FROM ${this.t('reaction_content')} r JOIN ${this.t('post')} p ON p.post_id = r.content_id
         WHERE r.content_type = 'post' AND p.thread_id IN (?) AND p.message_state = 'visible'`,
        [threadIds],
      );
      const { rows: mapped } = await this.pg.query<{ xf_post_id: number; post_id: string }>(
        'SELECT xf_post_id, post_id FROM yaktribe.post_map WHERE xf_post_id = ANY($1)',
        [[...new Set(reactions.map((reaction) => reaction.content_id))]],
      );
      const postIds = new Map(mapped.map((row) => [row.xf_post_id, row.post_id]));

      const likes: unknown[][] = [];
      const pending: unknown[][] = [];
      for (const reaction of reactions) {
        step.read++;
        if (reaction.reaction_id !== LIKE_REACTION_ID) {
          skip(step, 'not a Like (other reaction)');
          continue;
        }
        const liker = this.authors.get(reaction.reaction_user_id);
        if (!liker) {
          skip(step, 'liker account deleted on YakTribe');
          continue;
        }
        const postAuthor = this.authors.get(reaction.post_user_id);
        if (reaction.reaction_user_id === reaction.post_user_id || (liker.profileId && liker.profileId === postAuthor?.profileId)) {
          skip(step, 'own post');
          continue;
        }
        const postId = postIds.get(reaction.content_id)!;
        const date = fromUnix(reaction.reaction_date);
        if (liker.profileId) likes.push([postId, liker.profileId, date]);
        else pending.push([postId, liker.id, date]);
      }
      step.written += await insertRows(
        this.pg,
        'forum_post_likes',
        [['post_id', 'uuid'], ['user_id', 'uuid'], ['created_at', 'timestamptz']],
        likes,
        { onConflict: 'ON CONFLICT DO NOTHING' },
      );
      step.written += await insertRows(
        this.pg,
        'yaktribe.pending_likes',
        [['post_id', 'uuid'], ['author_id', 'uuid'], ['created_at', 'timestamptz']],
        pending,
        { onConflict: 'ON CONFLICT DO NOTHING' },
      );
      progress.tick(threadIds.length);
    }
    progress.finish();
  }

  private async importTags() {
    const step = this.report.step('Thread tags');
    const unmapped = new Map<string, number>();
    const prefixNames = new Map(
      (
        await this.xfRows<{ prefix_id: number; title: string }>(
          `SELECT p.prefix_id, ph.phrase_text AS title FROM ${this.t('thread_prefix')} p
           LEFT JOIN ${this.t('phrase')} ph ON ph.title = CONCAT('thread_prefix.', p.prefix_id) AND ph.language_id = 0`,
        )
      ).map((prefix) => [prefix.prefix_id, prefix.title ?? `prefix ${prefix.prefix_id}`]),
    );

    // Per thread in order of priority: the forum's tags, then the prefix's, then XenForo tags
    const tagsByThread = new Map<string, Set<string>>();
    const add = (threadId: string, tags: string[]) => {
      const set = tagsByThread.get(threadId) ?? new Set();
      for (const tag of tags) set.add(tag);
      tagsByThread.set(threadId, set);
    };
    for (const threadIds of this.threadChunks()) {
      const xfTags = await this.xfRows<{ content_id: number; tag: string }>(
        `SELECT tc.content_id, t.tag FROM ${this.t('tag_content')} tc JOIN ${this.t('tag')} t ON t.tag_id = tc.tag_id
         WHERE tc.content_type = 'thread' AND tc.content_id IN (?)`,
        [threadIds],
      );
      for (const xfThreadId of threadIds) {
        const thread = this.threads.get(xfThreadId)!;
        add(thread.id, this.mapping.forums.get(thread.nodeId)!.tags);
        if (!thread.prefixId) continue;
        step.read++;
        const mapped = this.mapping.prefixes.get(thread.prefixId);
        const label = `prefix "${prefixNames.get(thread.prefixId) ?? thread.prefixId}" (${thread.prefixId})`;
        if (mapped) add(thread.id, mapped);
        else unmapped.set(label, (unmapped.get(label) ?? 0) + 1);
      }
      for (const { content_id: xfThreadId, tag } of xfTags) {
        step.read++;
        const mapped = this.mapping.tags.get(tag.toLowerCase());
        if (mapped) add(this.threads.get(xfThreadId)!.id, mapped);
        else unmapped.set(`tag "${tag}"`, (unmapped.get(`tag "${tag}"`) ?? 0) + 1);
      }
    }
    skip(step, 'tag or prefix not in the mapping', [...unmapped.values()].reduce((sum, n) => sum + n, 0));
    const top = [...unmapped].sort((a, b) => b[1] - a[1]).slice(0, 25);
    if (top.length) {
      this.report.notes.push(`Most used tags and prefixes not in the mapping: ${top.map(([name, n]) => `${name} ×${n}`).join(', ')}.`);
    }

    const threadTags: [threadId: string, tag: string][] = [];
    for (const [threadId, tags] of tagsByThread) {
      const kept = [...tags].slice(0, MAX_TAGS);
      skip(step, `over the app's ${MAX_TAGS} tags per thread`, tags.size - kept.length);
      for (const tag of kept) threadTags.push([threadId, tag]);
    }
    const names = [...new Set(threadTags.map(([, tag]) => tag))];
    await insertRows(this.pg, 'forum_tags', [['name', 'text']], names.map((name) => [name]), { onConflict: 'ON CONFLICT (name) DO NOTHING' });
    const { rows } = await this.pg.query<{ id: string; name: string }>('SELECT id, name FROM forum_tags WHERE name = ANY($1)', [names]);
    const tagIds = new Map(rows.map((row) => [row.name, row.id]));
    for (const batch of chunks(threadTags, 10_000)) {
      step.written += await insertRows(
        this.pg,
        'forum_thread_tags',
        [['thread_id', 'uuid'], ['tag_id', 'uuid']],
        batch.map(([threadId, tag]) => [threadId, tagIds.get(tag)]),
      );
    }
  }

  /** What the disabled triggers would have kept: counters, last posts and thread authors. */
  private async recount() {
    const pg = this.pg;
    await pg.query(`
      UPDATE forum_threads t SET post_count = s.n, last_post_at = s.last_at
      FROM (
        SELECT p.thread_id, count(*) AS n, max(p.created_at) AS last_at
        FROM forum_posts p JOIN yaktribe.thread_map m ON m.thread_id = p.thread_id
        GROUP BY p.thread_id
      ) s
      WHERE t.id = s.thread_id`);
    await pg.query(`
      UPDATE forum_threads t SET author_id = p.author_id, imported_author_id = p.imported_author_id
      FROM forum_posts p, yaktribe.thread_map m
      WHERE m.thread_id = t.id AND p.thread_id = t.id AND p.post_number = 1`);
    await pg.query(`
      UPDATE forum_threads t SET last_post_author_id = p.author_id
      FROM forum_posts p, yaktribe.thread_map m
      WHERE m.thread_id = t.id AND p.thread_id = t.id AND p.post_number = t.post_count`);
    await pg.query(`
      UPDATE forum_posts p SET like_count =
        (SELECT count(*) FROM forum_post_likes l WHERE l.post_id = p.id) +
        (SELECT count(*) FROM yaktribe.pending_likes l WHERE l.post_id = p.id)
      WHERE p.id IN (SELECT post_id FROM yaktribe.post_map)`);
    await pg.query('UPDATE forum_categories c SET thread_count = (SELECT count(*) FROM forum_threads t WHERE t.category_id = c.id)');
  }
}

/** A post too long once converted: its text without BB code, cut to fit in `limit` characters. */
function truncated(message: string, limit: number): string {
  const note = '<p><em>[This post was cut short in the move from YakTribe.]</em></p>';
  const text = message.replace(/\[\/?[a-z*]+(?:=[^\]]*|\s[^\]]*)?\]/gi, '');
  let html = '';
  for (const paragraph of text.replace(/\r\n?/g, '\n').split(/\n\s*\n+/)) {
    const body = escapeHtml(paragraph.trim()).replace(/\n/g, '<br>');
    const room = limit - html.length - note.length - '<p></p>'.length;
    if (body.length <= room) {
      html += `<p>${body}</p>`;
      continue;
    }
    // Cut to fit, without leaving half an entity or <br> at the end
    const cut = body.slice(0, room).replace(/&[a-z]*$|<[a-z]*$/, '');
    if (cut) html += `<p>${cut}</p>`;
    break;
  }
  return html + note;
}
