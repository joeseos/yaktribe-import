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

export interface Mapping {
  forums: Map<number, { category: string; tags: string[] }>;
  categoryNames: Map<string, string>;
  tags: Map<string, string[]>;
  prefixes: Map<number, string[]>;
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
  const mapping: Mapping = { forums: new Map(), categoryNames: new Map(), tags: new Map(), prefixes: new Map() };
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#'));
  lines.forEach((line, i) => {
    if (i === 0 && /^source\s*,/i.test(line)) return;
    const [source, key, category = '', tagList = '', categoryName = ''] = splitCsvLine(line);
    const tags = tagList.split(';').map((tag) => tag.trim()).filter(Boolean);
    const where = `mapping line ${i + 1}`;
    switch (source.toLowerCase()) {
      case 'forum': {
        if (!/^\d+$/.test(key)) throw new Error(`${where}: forum key must be a node_id`);
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(category)) throw new Error(`${where}: forum needs a category slug`);
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
      default:
        throw new Error(`${where}: source must be forum, tag or prefix`);
    }
    for (const tag of tags) if (tag.length > 40) throw new Error(`${where}: tag "${tag}" is over 40 characters`);
  });
  if (!mapping.forums.size) throw new Error('The mapping lists no forums, so there is nothing to import');
  return mapping;
}

export function loadMapping(path: string): Mapping {
  return parseMapping(readFileSync(path, 'utf8'));
}
