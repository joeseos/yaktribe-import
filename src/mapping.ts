import { readFileSync } from 'node:fs';

// mapping.csv: which XenForo forums are imported, into which Munda Manager
// category, and which XenForo forums, tags and thread prefixes become which
// Munda Manager tags. Anything not listed is left out.
//
//   source,key,category,tags,category_name
//   forum,12,battle-reports,Necromunda;Campaigns    <- node_id; category slug required
//   forum,77,events,,Events & Campaigns             <- name for a category the import creates
//   tag,campaign,,Campaigns                         <- XenForo tag text
//   prefix,3,,Battle Report                         <- prefix_id
//   move,battle report;batrep,battle-reports,musings;hive-lore
//     <- words in the title or XenForo tags; the category; the categories it takes threads from

export interface Mapping {
  forums: Map<number, { category: string; tags: string[] }>;
  categoryNames: Map<string, string>;
  tags: Map<string, string[]>;
  prefixes: Map<number, string[]>;
  moves: Move[];
}

interface Move {
  /** One of the words, as whole words or plural, in the title or a tag */
  words: RegExp;
  category: string;
  from: Set<string>;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The category a thread goes into: the first move whose words are in its title or tags, or its forum's category. */
export function threadCategory(mapping: Mapping, category: string, title: string, tags: string[]): string {
  const move = mapping.moves.find(
    (move) => move.from.has(category) && [title, ...tags].some((text) => move.words.test(text)),
  );
  return move?.category ?? category;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else cell += char;
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

export function parseMapping(csv: string): Mapping {
  const mapping: Mapping = { forums: new Map(), categoryNames: new Map(), tags: new Map(), prefixes: new Map(), moves: [] };
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#'));
  lines.forEach((line, i) => {
    if (i === 0 && /^source\s*,/i.test(line)) return;
    const [source, key, category = '', tagList = '', categoryName = ''] = splitCsvLine(line);
    const tags = tagList.split(';').map((tag) => tag.trim()).filter(Boolean);
    const where = `mapping line ${i + 1}`;
    switch (source.toLowerCase()) {
      case 'forum': {
        if (!/^\d+$/.test(key)) throw new Error(`${where}: forum key must be a node_id`);
        if (!SLUG.test(category)) throw new Error(`${where}: forum needs a category slug`);
        mapping.forums.set(Number(key), { category, tags });
        if (categoryName) mapping.categoryNames.set(category, categoryName);
        break;
      }
      case 'tag':
        mapping.tags.set(key.toLowerCase(), tags);
        break;
      case 'prefix':
        if (!/^\d+$/.test(key)) throw new Error(`${where}: prefix key must be a prefix_id`);
        mapping.prefixes.set(Number(key), tags);
        break;
      case 'move': {
        const words = key.split(';').map((word) => word.replace(/\s+/g, ' ').trim()).filter(Boolean);
        if (!words.length) throw new Error(`${where}: move needs words`);
        if (!SLUG.test(category)) throw new Error(`${where}: move needs a category slug`);
        if (!tags.length || !tags.every((slug) => SLUG.test(slug))) throw new Error(`${where}: move needs the category slugs it takes threads from`);
        const pattern = `(?<![\\p{L}\\p{N}])(${words.map(escapeRegExp).join('|')})s?(?![\\p{L}\\p{N}])`;
        mapping.moves.push({ words: new RegExp(pattern, 'iu'), category, from: new Set(tags) });
        if (categoryName) mapping.categoryNames.set(category, categoryName);
        break;
      }
      default:
        throw new Error(`${where}: source must be forum, tag, prefix or move`);
    }
    for (const tag of tags) if (tag.length > 40) throw new Error(`${where}: tag "${tag}" is over 40 characters`);
  });
  if (!mapping.forums.size) throw new Error('The mapping lists no forums, so there is nothing to import');
  const categories = new Set([...mapping.forums.values()].map(({ category }) => category));
  for (const move of mapping.moves) {
    const unknown = [...move.from].filter((slug) => !categories.has(slug));
    if (unknown.length) throw new Error(`A move takes threads from categories no forum goes into: ${unknown.join(', ')}`);
  }
  return mapping;
}

export function loadMapping(path: string): Mapping {
  return parseMapping(readFileSync(path, 'utf8'));
}
