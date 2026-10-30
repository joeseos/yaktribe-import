// XenForo BB code to the HTML Munda Manager's forum editor writes.
//
// The output only uses tags the app's sanitizer keeps (sanitizeArticleHtml),
// and the app sanitizes again on every read, so anything odd here is dropped
// there rather than shown. Quotes come out in the app's own quote shape so
// "Quote" on a reply still strips them.

type TextNode = { type: 'text'; text: string };
type ItemNode = { type: 'item' };
type TagNode = { type: 'tag'; name: string; option: string | null; attrs: Record<string, string>; children: Node[] };
type Node = TextNode | ItemNode | TagNode;

/** Looks up what the message points at in the new forum. Filled per batch from the import's maps. */
export interface Resolver {
  /** Path of the page a post is on, with #post-N, or null if the post wasn't imported. */
  postHref(xfPostId: number): string | null;
  threadHref(xfThreadId: number): string | null;
  /** The Munda Manager profile a XenForo user claimed, for a mention link. */
  mention(xfUserId: number): { profileId: string } | null;
}

export interface ConvertStats {
  unknownTags: Record<string, number>;
  /** Tags converted with something lost, e.g. [COLOR] keeps its text but not the colour. */
  lossyTags: Record<string, number>;
  attachmentsDropped: number;
  httpImagesLinked: number;
}

export function emptyStats(): ConvertStats {
  return { unknownTags: {}, lossyTags: {}, attachmentsDropped: 0, httpImagesLinked: 0 };
}

const KNOWN = new Set([
  'b', 'i', 'u', 's', 'color', 'font', 'size', 'url', 'email', 'img', 'quote', 'code', 'php', 'html',
  'icode', 'plain', 'list', 'left', 'center', 'right', 'justify', 'indent', 'heading', 'spoiler',
  'ispoiler', 'media', 'attach', 'user', 'hr', 'table', 'tr', 'td', 'th', 'sub', 'sup',
]);
// Their content is taken as it is, not parsed for more tags
const RAW = new Set(['code', 'php', 'html', 'icode', 'plain', 'img', 'media', 'attach']);
const VOID = new Set(['hr']);
const BLOCK = new Set([
  'quote', 'code', 'php', 'html', 'list', 'heading', 'spoiler', 'left', 'center', 'right', 'justify',
  'indent', 'table', 'hr',
]);
const LOSSY = new Set(['color', 'font', 'size', 'left', 'center', 'right', 'justify', 'indent', 'table', 'sub', 'sup', 'ispoiler']);

const TAG = /\[(\/?)([a-z]+|\*)(=[^\]]*|\s[^\]]*)?\]/gi;
const YAKTRIBE_LINK = /^https?:\/\/(?:www\.)?yaktribe\.games\/community\/(threads|posts)\/(?:[^/]*\.)?(\d+)\/?/i;
// A URL typed as plain text, without the punctuation that usually follows one
const BARE_URL = /https?:\/\/[^\s<>"[\]]*[^\s<>"[\].,;:!?)']/gi;

function bump(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unquote(value: string): string {
  return value.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
}

function parseOption(raw: string | undefined): { option: string | null; attrs: Record<string, string> } {
  if (!raw) return { option: null, attrs: {} };
  if (raw.startsWith('=')) return { option: unquote(raw.slice(1)), attrs: {} };
  const attrs: Record<string, string> = {};
  for (const [, key, value] of raw.matchAll(/([a-z]+)=("[^"]*"|'[^']*'|\S+)/gi)) attrs[key.toLowerCase()] = unquote(value);
  return { option: null, attrs };
}

export function parse(message: string, stats: ConvertStats): Node[] {
  const text = message.replace(/\r\n?/g, '\n');
  const root: TagNode = { type: 'tag', name: '', option: null, attrs: {}, children: [] };
  const stack: TagNode[] = [root];
  const top = () => stack[stack.length - 1];
  const pushText = (value: string) => {
    if (!value) return;
    const siblings = top().children;
    const last = siblings[siblings.length - 1];
    if (last?.type === 'text') last.text += value;
    else siblings.push({ type: 'text', text: value });
  };

  let index = 0;
  TAG.lastIndex = 0;
  for (let match = TAG.exec(text); match; match = TAG.exec(text)) {
    const [whole, slash, rawName, rawOption] = match;
    const name = rawName.toLowerCase();
    pushText(text.slice(index, match.index));
    index = match.index + whole.length;

    if (name === '*') {
      if (slash) continue;
      top().children.push({ type: 'item' });
      continue;
    }
    if (!KNOWN.has(name)) {
      if (!slash) bump(stats.unknownTags, name);
      pushText(whole);
      continue;
    }
    if (slash) {
      const open = stack.findLastIndex((node, i) => i > 0 && node.name === name);
      if (open === -1) {
        if (!VOID.has(name)) pushText(whole);
        continue;
      }
      stack.length = open;
      continue;
    }

    const node: TagNode = { type: 'tag', name, ...parseOption(rawOption), children: [] };
    top().children.push(node);
    if (VOID.has(name)) continue;
    if (RAW.has(name)) {
      const close = text.toLowerCase().indexOf(`[/${name}]`, index);
      const end = close === -1 ? text.length : close;
      if (end > index) node.children.push({ type: 'text', text: text.slice(index, end) });
      index = close === -1 ? text.length : close + name.length + 3;
      TAG.lastIndex = index;
      continue;
    }
    stack.push(node);
  }
  pushText(text.slice(index));
  return root.children;
}

function rawText(node: TagNode): string {
  return node.children.map((child) => (child.type === 'text' ? child.text : '')).join('');
}

/** The ids a message refers to, so the import can look them all up for a batch at once. */
export function collectRefs(nodes: Node[], refs = { postIds: new Set<number>(), threadIds: new Set<number>(), userIds: new Set<number>() }) {
  const addLink = (href: string) => {
    const link = YAKTRIBE_LINK.exec(href);
    if (link) (link[1].toLowerCase() === 'posts' ? refs.postIds : refs.threadIds).add(Number(link[2]));
  };
  for (const node of nodes) {
    if (node.type === 'text') {
      for (const [href] of node.text.matchAll(BARE_URL)) addLink(href);
      continue;
    }
    if (node.type !== 'tag') continue;
    if (node.name === 'quote') {
      const post = node.option && /post:\s*(\d+)/i.exec(node.option);
      if (post) refs.postIds.add(Number(post[1]));
    }
    if (node.name === 'user' && node.option && /^\d+$/.test(node.option)) refs.userIds.add(Number(node.option));
    if (node.name === 'url') addLink(node.option ?? rawText(node));
    collectRefs(node.children, refs);
  }
  return refs;
}

class Renderer {
  private readonly resolver: Resolver;
  private readonly stats: ConvertStats;
  /** Inside a link's label, where plain URLs must not become links of their own */
  private insideLink = 0;

  constructor(resolver: Resolver, stats: ConvertStats) {
    this.resolver = resolver;
    this.stats = stats;
  }

  private href(url: string): string | null {
    const trimmed = url.trim();
    const link = YAKTRIBE_LINK.exec(trimmed);
    if (link) {
      const id = Number(link[2]);
      const moved = link[1].toLowerCase() === 'posts' ? this.resolver.postHref(id) : this.resolver.threadHref(id);
      if (moved) return moved;
    }
    if (/^\/community\//.test(trimmed)) return `https://yaktribe.games${trimmed}`;
    if (/^www\./i.test(trimmed)) return `https://${trimmed}`;
    return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null;
  }

  private link(url: string, label: string): string {
    const href = this.href(url);
    return href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
  }

  private text(text: string, autolink = this.insideLink === 0): string {
    const plain = (part: string) => escapeHtml(part).replace(/\n/g, '<br>');
    if (!autolink) return plain(text);
    let html = '';
    let last = 0;
    for (const { 0: url, index } of text.matchAll(BARE_URL)) {
      html += plain(text.slice(last, index)) + this.link(url, escapeHtml(url));
      last = index + url.length;
    }
    return html + plain(text.slice(last));
  }

  private label(node: TagNode): string {
    this.insideLink++;
    try {
      return this.inlineChildren(node.children);
    } finally {
      this.insideLink--;
    }
  }

  private inlineChildren(nodes: Node[]): string {
    return nodes.map((node) => this.inline(node)).join('');
  }

  private inline(node: Node): string {
    if (node.type === 'text') return this.text(node.text);
    if (node.type === 'item') return '';
    if (LOSSY.has(node.name)) bump(this.stats.lossyTags, node.name);
    const inner = () => this.inlineChildren(node.children);
    switch (node.name) {
      case 'b': return `<strong>${inner()}</strong>`;
      case 'i': return `<em>${inner()}</em>`;
      case 'u': return `<u>${inner()}</u>`;
      case 's': return `<s>${inner()}</s>`;
      case 'icode':
      case 'code':
      case 'php':
      case 'html': return `<code>${escapeHtml(rawText(node))}</code>`;
      case 'plain': return this.text(rawText(node), false);
      case 'url': return this.link(node.option ?? rawText(node), node.option ? this.label(node) : escapeHtml(rawText(node)));
      case 'email': {
        const address = node.option ?? rawText(node);
        return `<a href="mailto:${escapeHtml(address)}">${node.option ? this.label(node) : escapeHtml(address)}</a>`;
      }
      case 'img': {
        const src = rawText(node).trim();
        if (/^https:\/\//i.test(src)) return `<img src="${escapeHtml(src)}" alt="${escapeHtml(node.attrs.alt ?? '')}">`;
        this.stats.httpImagesLinked++;
        return this.link(src, escapeHtml(src));
      }
      case 'media': {
        const id = rawText(node).trim();
        const site = (node.option ?? '').toLowerCase();
        const url = site === 'youtube' ? `https://www.youtube.com/watch?v=${id}` : site === 'vimeo' ? `https://vimeo.com/${id}` : null;
        if (!url) bump(this.stats.lossyTags, `media=${site}`);
        return url ? this.link(url, escapeHtml(url)) : escapeHtml(id);
      }
      case 'attach':
        this.stats.attachmentsDropped++;
        return '<em>[attachment not migrated]</em>';
      case 'user': {
        const profile = node.option && /^\d+$/.test(node.option) ? this.resolver.mention(Number(node.option)) : null;
        const label = rawText(node).replace(/^@/, '');
        return profile
          ? `<a data-type="mention" data-id="${profile.profileId}" data-label="${escapeHtml(label)}">@${escapeHtml(label)}</a>`
          : `<strong>@${escapeHtml(label)}</strong>`;
      }
      case 'hr': return '';
      default: return inner();
    }
  }

  /** Children of a block container: text split into paragraphs, block tags as their own blocks. */
  blocks(nodes: Node[]): string {
    const out: string[] = [];
    let paragraph = '';
    const flush = () => {
      const html = paragraph.replace(/^(\s|<br>)+|(\s|<br>)+$/g, '');
      if (html) out.push(`<p>${html}</p>`);
      paragraph = '';
    };
    for (const node of nodes) {
      if (node.type === 'text') {
        node.text.split(/\n[ \t]*\n+/).forEach((part, i) => {
          if (i > 0) flush();
          paragraph += this.text(part);
        });
      } else if (node.type === 'tag' && BLOCK.has(node.name)) {
        flush();
        out.push(this.block(node));
      } else {
        paragraph += this.inline(node);
      }
    }
    flush();
    return out.join('');
  }

  private block(node: TagNode): string {
    if (LOSSY.has(node.name)) bump(this.stats.lossyTags, node.name);
    switch (node.name) {
      case 'quote': return this.quote(node);
      case 'code':
      case 'php':
      case 'html': return `<pre><code>${escapeHtml(rawText(node).replace(/^\n+|\n+$/g, ''))}</code></pre>`;
      case 'list': {
        const items: Node[][] = [];
        for (const child of node.children) {
          if (child.type === 'item') items.push([]);
          else if (items.length) items[items.length - 1].push(child);
        }
        const tag = node.option ? 'ol' : 'ul';
        return `<${tag}>${items.map((item) => `<li>${this.blocks(item) || '<p></p>'}</li>`).join('')}</${tag}>`;
      }
      case 'heading': {
        const level = Math.min(Math.max(Number(node.option) || 1, 1), 3) + 1;
        return `<h${level}>${this.inlineChildren(node.children)}</h${level}>`;
      }
      case 'spoiler': {
        const title = node.option ? `: ${escapeHtml(node.option)}` : '';
        return `<blockquote><p><strong>Spoiler${title}</strong></p>${this.blocks(node.children)}</blockquote>`;
      }
      case 'hr': return '<hr>';
      case 'table':
        return node.children
          .filter((row): row is TagNode => row.type === 'tag' && row.name === 'tr')
          .map((row) => {
            const cells = row.children.filter((cell): cell is TagNode => cell.type === 'tag');
            return `<p>${cells.map((cell) => this.inlineChildren(cell.children).trim()).join(' | ')}</p>`;
          })
          .join('');
      default: return this.blocks(node.children);
    }
  }

  private quote(node: TagNode): string {
    const body = this.blocks(node.children);
    if (!node.option) return `<blockquote>${body}</blockquote>`;
    const [, name = '', post] = /^\s*(.*?)\s*(?:,\s*post:\s*(\d+))?(?:,\s*member:\s*\d+)?\s*$/i.exec(node.option) ?? [];
    if (!name) return `<blockquote>${body}</blockquote>`;
    const href = post ? this.resolver.postHref(Number(post)) : null;
    const author = href ? `<a href="${escapeHtml(href)}">${escapeHtml(name)}</a>` : escapeHtml(name);
    return `<blockquote><p>Originally posted by <strong>${author}</strong></p>${body}</blockquote>`;
  }
}

export function render(nodes: Node[], resolver: Resolver, stats: ConvertStats): string {
  return new Renderer(resolver, stats).blocks(nodes) || '<p></p>';
}

export function bbcodeToHtml(message: string, resolver: Resolver, stats = emptyStats()): string {
  return render(parse(message, stats), resolver, stats);
}
