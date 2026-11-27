import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bbcodeToHtml, collectRefs, emptyStats, parse, type Resolver } from '../src/bbcode.ts';

const PROFILE = '0b6a3c5e-6f43-4a39-9c2b-4a1f0b0c9d11';
const resolver: Resolver = {
  postHref: (id) => (id === 10 ? '/forum/battle-reports/7-first-blood#post-3' : null),
  threadHref: (id) => (id === 7 ? '/forum/battle-reports/7-first-blood' : null),
  mention: (id) => (id === 45 ? { profileId: PROFILE } : null),
  attachment: (id) => (id === 5 ? { src: 'https://img.test/attachments/5.webp' } : id === 6 ? { src: null } : null),
  galleryMedia: (id) => (id === 12 ? { src: 'https://img.test/attachments/80.webp' } : null),
};
const html = (message: string, stats = emptyStats()) => bbcodeToHtml(message, resolver, stats);

test('paragraphs and line breaks', () => {
  assert.equal(html('One\nline two\n\nNew paragraph'), '<p>One<br>line two</p><p>New paragraph</p>');
  assert.equal(html(''), '<p></p>');
});

test('inline formatting and escaping', () => {
  assert.equal(html('[B]bold[/B] [i]it[/i] <script>'), '<p><strong>bold</strong> <em>it</em> &lt;script&gt;</p>');
});

test('quotes use the app quote shape and link to the imported post', () => {
  assert.equal(
    html('[QUOTE="Bob, post: 10, member: 2"]Hi[/QUOTE]\nReply'),
    '<blockquote><p>Originally posted by <strong><a href="/forum/battle-reports/7-first-blood#post-3">Bob</a></strong></p><p>Hi</p></blockquote><p>Reply</p>',
  );
  assert.equal(html('[quote=Ann]x[/quote]'), '<blockquote><p>Originally posted by <strong>Ann</strong></p><p>x</p></blockquote>');
  assert.equal(html('[quote]x[/quote]'), '<blockquote><p>x</p></blockquote>');
});

test('links: safe schemes only, YakTribe links rewritten and show their new address', () => {
  assert.equal(html('[url=https://a.com]A[/url]'), '<p><a href="https://a.com">A</a></p>');
  assert.equal(html('[url=javascript:alert(1)]x[/url]'), '<p>x</p>');
  assert.equal(
    html('[url]https://yaktribe.games/community/threads/first-blood.7/[/url]'),
    '<p><a href="/forum/battle-reports/7-first-blood">https://www.mundamanager.com/forum/battle-reports/7-first-blood</a></p>',
  );
  assert.equal(
    html('[url=https://yaktribe.games/community/threads/first-blood.7/]First Blood[/url]'),
    '<p><a href="/forum/battle-reports/7-first-blood">First Blood</a></p>',
  );
  for (const url of [
    'https://yaktribe.games/community/threads/first-blood.7/post-10',
    'https://yaktribe.games/community/threads/first-blood.7/#post-10',
    'https://yaktribe.games/community/threads/first-blood.7/page-2#post-10',
  ]) {
    assert.equal(
      html(`[url=${url}]that post[/url]`),
      '<p><a href="/forum/battle-reports/7-first-blood#post-3">that post</a></p>',
    );
  }
  assert.equal(
    html('[url]https://yaktribe.games/community/threads/gone.8/[/url]'),
    '<p><a href="https://yaktribe.games/community/threads/gone.8/">https://yaktribe.games/community/threads/gone.8/</a></p>',
  );
});

test('plain URLs become links, but not inside a link or [plain]', () => {
  assert.equal(
    html('See https://a.com/x?a=1&b=2. Or https://yaktribe.games/community/posts/10/'),
    '<p>See <a href="https://a.com/x?a=1&amp;b=2">https://a.com/x?a=1&amp;b=2</a>. Or <a href="/forum/battle-reports/7-first-blood#post-3">https://www.mundamanager.com/forum/battle-reports/7-first-blood#post-3</a></p>',
  );
  assert.equal(html('[url=https://a.com]go to https://b.com[/url]'), '<p><a href="https://a.com">go to https://b.com</a></p>');
  assert.equal(html('[plain]https://a.com[/plain]'), '<p>https://a.com</p>');
  assert.equal(html('http://bit.ly/Uhy8kB'), '<p><a href="https://bit.ly/Uhy8kB">http://bit.ly/Uhy8kB</a></p>');
});

test('images: https kept, http becomes a link', () => {
  const stats = emptyStats();
  assert.equal(html('[IMG]https://i.imgur.com/a.png[/IMG]', stats), '<p><img src="https://i.imgur.com/a.png" alt=""></p>');
  assert.equal(html('[img]http://x.com/a.png[/img]', stats), '<p><a href="https://x.com/a.png">http://x.com/a.png</a></p>');
  assert.equal(stats.httpImagesLinked, 1);
});

test('image attachments show from the bucket, other attachments are dropped', () => {
  const stats = emptyStats();
  assert.equal(html('[ATTACH type="full" alt="Goliath"]5[/ATTACH]', stats), '<p><img src="https://img.test/attachments/5.webp" alt="Goliath"></p>');
  assert.equal(html('[ATTACH]6[/ATTACH]', stats), '<p><em>[image]</em></p>');
  assert.equal(html('[ATTACH type="full" alt="x"]123[/ATTACH]', stats), '<p><em>[attachment not migrated]</em></p>');
  assert.equal(stats.imagesLinked, 2);
  assert.equal(stats.attachmentsDropped, 1);
});

test('public gallery images show from the bucket, albums and other items are dropped', () => {
  const stats = emptyStats();
  assert.equal(html('[GALLERY=media, 12][/GALLERY]', stats), '<p><img src="https://img.test/attachments/80.webp" alt=""></p>');
  assert.equal(html('[GALLERY=media, 13][/GALLERY]', stats), '<p><em>[gallery item not migrated]</em></p>');
  assert.equal(html('[GALLERY=album, 12][/GALLERY]', stats), '<p><em>[gallery item not migrated]</em></p>');
  assert.equal(stats.imagesLinked, 1);
  assert.equal(stats.galleryDropped, 2);
  assert.deepEqual(stats.unknownTags, {});
});

test('mentions link to a claimed profile, else bold text', () => {
  assert.equal(
    html('[USER=45]@Kal[/USER] and [USER=46]@Zed[/USER]'),
    `<p><a data-type="mention" data-id="${PROFILE}" data-label="Kal">@Kal</a> and <strong>@Zed</strong></p>`,
  );
});

test('lists, code and headings', () => {
  assert.equal(html('[LIST]\n[*]One\n[*]Two\n[/LIST]'), '<ul><li><p>One</p></li><li><p>Two</p></li></ul>');
  assert.equal(html('[list=1][*]A[/list]'), '<ol><li><p>A</p></li></ol>');
  assert.equal(html('[CODE]\n[b]<x>[/b]\n[/CODE]'), '<pre><code>[b]&lt;x&gt;[/b]</code></pre>');
  assert.equal(html('[HEADING=1]Title[/HEADING]'), '<h2>Title</h2>');
});

test('spoilers, media and lossy tags', () => {
  const stats = emptyStats();
  assert.equal(html('[SPOILER=Ending]x[/SPOILER]', stats), '<blockquote><p><strong>Spoiler: Ending</strong></p><p>x</p></blockquote>');
  assert.equal(
    html('[MEDIA=youtube]abc[/MEDIA]', stats),
    '<p><a href="https://www.youtube.com/watch?v=abc">https://www.youtube.com/watch?v=abc</a></p>',
  );
  assert.equal(html('[COLOR=red]red[/COLOR]', stats), '<p>red</p>');
  assert.equal(stats.lossyTags.color, 1);
});

test('unknown and unbalanced tags stay as text', () => {
  const stats = emptyStats();
  assert.equal(html('[foo]x[/foo] [/b] [b]open', stats), '<p>[foo]x[/foo] [/b] <strong>open</strong></p>');
  assert.equal(stats.unknownTags.foo, 1);
  html('[constructor] [constructor]', stats);
  assert.equal(stats.unknownTags.constructor, 2);
});

test('an unclosed raw tag stays as text', () => {
  assert.equal(html('Wrap it in [img] tags, then [b]bold[/b]'), '<p>Wrap it in [img] tags, then <strong>bold</strong></p>');
  assert.equal(html('İ [ICODE]x[/icode] y'), '<p>İ <code>x</code> y</p>');
});

test('collectRefs finds quoted posts, mentions, YakTribe links and images', () => {
  const refs = collectRefs(
    parse('[quote="A, post: 10"]x[/quote][user=45]@K[/user] https://yaktribe.games/community/posts/99/ [url=https://yaktribe.games/community/threads/x.7/]t[/url] https://yaktribe.games/community/threads/x.7/post-150 [ATTACH]5[/ATTACH] [GALLERY=media, 12][/GALLERY] [GALLERY=album, 3][/GALLERY]', emptyStats()),
  );
  assert.deepEqual([...refs.attachmentIds], [5]);
  assert.deepEqual([...refs.mediaIds], [12]);
  assert.deepEqual([...refs.postIds].sort((a, b) => a - b), [10, 99, 150]);
  assert.deepEqual([...refs.threadIds], [7]);
  assert.deepEqual([...refs.userIds], [45]);
});

test('smilies become emoji, except in code, [plain] and words', () => {
  assert.equal(html('Thanks! (y) :):):) >:( o_O'), '<p>Thanks! 👍 🙂🙂🙂 😠 🤨</p>');
  assert.equal(html('great:) :Do ño_O hello.Our (y)!'), '<p>great🙂 :Do ño_O hello.Our 👍!</p>');
  assert.equal(html('[icode]:)[/icode] [plain]:p[/plain]'), '<p><code>:)</code> :p</p>');
  assert.equal(html('[code]:D[/code]'), '<pre><code>:D</code></pre>');
  assert.equal(html('see https://a.com/x:p ;)'), '<p>see <a href="https://a.com/x:p">https://a.com/x:p</a> 😉</p>');
});
