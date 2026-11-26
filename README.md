# yaktribe-import

Imports the YakTribe XenForo 2 forum into the Munda Manager forum.

It's a command-line tool. It reads a MariaDB/MySQL copy of the XenForo database and writes straight to a Munda Manager Postgres database. It shows progress for each step, and at the end it writes a report (HTML and JSON) listing what was read, written and skipped, and why.

Everything runs in one transaction. A failure, or a `--dry-run`, leaves Munda Manager as it was. Running it again replaces the previous import rather than adding to it, and the threads get new numbers.

## What it imports

| XenForo | Munda Manager |
| --- | --- |
| Threads in the forums listed in `mapping.csv` (visible ones that have at least one visible post; redirects are skipped) | `forum_threads` in the mapped category, numbered after the app's own threads in YakTribe's order. `yaktribe.thread_map` keeps the old id, so old thread URLs can redirect |
| Visible posts, BB code converted to the app's HTML | `forum_posts`, numbered in thread order, with their original dates |
| Post authors and Like-givers | `forum_imported_authors`, linked to a Munda Manager profile when the email matches a confirmed account |
| Likes (reaction 1) | `forum_post_likes` for matched accounts. The rest wait in `yaktribe.pending_likes` until the person claims their YakTribe posts. `like_count` counts both |
| The forum, its tags and its prefix, through `mapping.csv` | `forum_tags` and `forum_thread_tags` |
| Image attachments of imported posts, and public gallery images the posts embed with `[GALLERY]` | Images from the image bucket, plus a list of the files to copy there (see [Images](#images)) |

It leaves out edit history, private messages, permissions, other reactions, and file attachments, which become *[attachment not migrated]*. Gallery albums and private or members-only gallery items become *[gallery item not migrated]*. https images stay as hotlinked images; http images become links. Links to YakTribe threads and posts that were imported point at their new pages. A thread's poll becomes its final results, as text at the end of the opening post.

## Mapping

Copy `mapping.example.csv` to `mapping.csv`, or `mapping.yaktribe.csv` for the agreed YakTribe structure. Only forums listed there are imported, and only tags and prefixes listed there become tags.

```csv
source,key,category,tags,category_name
forum,2,n26-rules-gang-discussion,Necromunda
forum,3,rules-mechanics,,Rules & Mechanics
tag,campaign,,Campaigns
prefix,1,,Battle Report
```

- `forum`: a XenForo `node_id`, the Munda Manager category slug its threads go into, and optional tags. Separate several tags with `;`. A category that doesn't exist yet is created with `category_name`, or a name made from the slug, and the report says so.
- `tag`: a XenForo tag, and the tags it becomes.
- `prefix`: a XenForo `prefix_id`, and the tags it becomes.

The report lists the forums, tags and prefixes that aren't in the mapping, so you can see what was left out.

## Running it

Needs Node 22.18 or newer.

```sh
npm install
cp .env.example .env              # then fill in both database URLs
cp mapping.example.csv mapping.csv
npm run import -- --dry-run       # every step, then roll back
npm run import -- --limit-threads 200
npm run import
```

`npm run import -- --help` lists the options. Reports go to `reports/`.

Connect to Postgres as `postgres` (the database owner). The import turns off the forum triggers on `forum_threads`, `forum_posts` and `forum_post_likes` while it runs, then recounts what they would have kept.

### On the VPS

Run it from the VPS terminal (as root, over SSH or in Coolify's server terminal). Both databases run there, so no tunnel is needed. There's no web page: you start it with a command, watch the progress lines, and open the HTML report afterwards.

The server doesn't need Node installed. A throwaway Node container runs it:

```sh
git clone https://github.com/joeseos/yaktribe-import.git && cd yaktribe-import
cp .env.example .env              # then fill in both database URLs
cp mapping.yaktribe.csv mapping.csv
tmux new -s import                # keeps the import running if SSH drops; reattach with: tmux attach -t import
docker run --rm -it --network host -v "$PWD":/app -w /app node:22 \
  sh -c "npm ci && npm run import -- --dry-run"
```

Run the same `docker run` without `--dry-run` for the real import. To update the tool later, run `git pull`.

`--network host` lets the container reach the databases on the server's `localhost` ports, so `.env` uses `localhost` and the ports the MariaDB and Supabase Postgres containers publish.

The report lands in `reports/` on the server. To open it, copy it to your computer:

```sh
scp root@<vps>:yaktribe-import/reports/import-*.html .
```

1. Load the YakTribe dump into the MariaDB container.
2. Do a dry run against the test Supabase, read the report, and fix the mapping until it looks right.
3. Do the real import into the test Supabase and check the forum in the test app.

Never point a test run at production. For the production import, it's the same command with `MM_DATABASE_URL` set to production's direct Postgres connection.

## Images

The image files aren't in the database dump, so the import doesn't copy them. It writes `reports/images-<time>.csv`, which lists every image the imported posts show, and the posts point at that file's place in the bucket:

| Column | |
| --- | --- |
| `name` | Path in the bucket, `attachments/<attachment id>.webp`, for post images and gallery items alike |
| `source_url` | The full-size image on YakTribe |
| `file_path` | The same file on YakTribe's server, relative to the XenForo folder |
| `external_url` | Set when a XenForo add-on stored the file somewhere else |
| `file_size`, `filename` | As uploaded |

`npm run images -- reports/images-<time>.csv` downloads every file from YakTribe (3 at a time, `--concurrency` to change), converts it to WebP (at most 2560 px on the longest side) and saves it as `images/<name>`. Files already there are skipped, so a stopped run can be started again; failures are listed in `images/failed.csv`. Then copy the `images` folder to the bucket, for example with rclone over Supabase Storage's S3 access keys:

```sh
rclone copy images supabase:users-images/forum/yaktribe --header-upload "Cache-Control: max-age=31536000" --exclude failed.csv
```

Once the files are in place, set `IMAGE_BASE_URL` in `.env` to the bucket's public URL (for example `https://<project>.supabase.co/storage/v1/object/public/users-images/forum/yaktribe`) and run the import. Without it, posts show *[image]* where the images go. Image attachments that a post doesn't place in its text are added below it, as XenForo shows them.

## Before a production import

- `sql/import-schema.sql` adds `forum_imported_authors` and an `imported_author_id` column on `forum_threads` and `forum_posts`. The import creates them if they're missing, which is fine on a test database. For production they belong in a Munda Manager migration, together with the app changes that show imported authors and the "Claim YakTribe posts" button.
- The `yaktribe` schema keeps the id maps (for redirects from old URLs), hashed emails (for claiming) and pending likes. Nobody but the database owner can read it.

## Testing

```sh
npm test            # BB code conversion
npm run typecheck
```

`test/fixtures/xenforo.sql` is a tiny XenForo forum with one of each case the import handles, and `test/fixtures/munda-manager.sql` adds three accounts and one thread of the app's own. Load them into an empty MariaDB database and a Munda Manager database, use the mapping below, and run the import:

```csv
source,key,category,tags,category_name
forum,2,gang-discussion,Necromunda,Gangs & Loadouts
forum,3,battle-reports,Necromunda;Battle Report
tag,campaign,,Campaigns
tag,scenery,,Terrain;Scenery
prefix,1,,Battle Report
```
