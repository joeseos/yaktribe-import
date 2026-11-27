// Downloads the files in an image manifest (reports/images-*.csv) from YakTribe
// and saves each as WebP under its bucket name, ready to upload.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { Progress } from './progress.ts';

const usage = `Usage: npm run images -- <reports/images-….csv> [--out images] [--concurrency 3]

Downloads each file in the manifest from YakTribe, converts it to WebP and saves
it as <out>/<name>. Files already there are skipped, so a stopped run can be
started again. Failures are listed in <out>/failed.csv.`;

/** Longest side in pixels; larger images are scaled down */
const MAX_SIZE = 2560;
const ATTEMPTS = 3;

interface Row {
  name: string;
  sourceUrl: string;
  externalUrl: string;
}

/** The manifest's own format: a plain header, then every field quoted with quotes doubled, one row per line. */
function parseManifest(text: string): Row[] {
  const [header, ...lines] = text.split('\n').filter((line) => line.trim());
  const columns = fields(header);
  const at = (name: string) => {
    const index = columns.indexOf(name);
    if (index < 0) throw new Error(`The manifest has no ${name} column`);
    return index;
  };
  const [name, source, external] = [at('name'), at('source_url'), at('external_url')];
  return lines.map((line) => {
    const values = fields(line);
    return { name: values[name], sourceUrl: values[source], externalUrl: values[external] };
  });
}

function fields(line: string): string[] {
  return [...line.matchAll(/"((?:[^"]|"")*)"|([^,]+)/g)].map((match) => (match[1] ?? match[2]).replace(/""/g, '"'));
}

class Permanent extends Error {}

/** Retries network errors, 429 and 5xx; a missing file or a login page fails at once. */
async function download(url: string): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        const message = `HTTP ${response.status}`;
        throw response.status === 429 || response.status >= 500 ? new Error(message) : new Permanent(message);
      }
      const type = response.headers.get('content-type') ?? '';
      if (!type.startsWith('image/')) throw new Permanent(`not an image (${type || 'no type'}), probably a login page`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof Permanent || attempt >= ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', default: 'images' },
      concurrency: { type: 'string', default: '3' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(usage);
    if (!values.help) process.exitCode = 1;
    return;
  }
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a whole number above 0');

  const out = values.out;
  const rows = parseManifest(readFileSync(positionals[0], 'utf8'));
  const todo = rows.filter((row) => !existsSync(join(out, row.name)));
  console.log(`${rows.length - todo.length} of ${rows.length} files already downloaded`);

  const failed: string[] = [];
  const progress = new Progress('Images', todo.length);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const row = todo[next++];
      const url = row.externalUrl || row.sourceUrl;
      const target = join(out, row.name);
      try {
        const image = await download(url);
        mkdirSync(dirname(target), { recursive: true });
        // Written beside the target and renamed, so a stopped run leaves no half file.
        // failOn 'none': browsers show slightly corrupt JPEGs, so they're kept.
        await sharp(image, { animated: true, failOn: 'none' })
          .rotate()
          .resize({ width: MAX_SIZE, height: MAX_SIZE, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(`${target}.part`);
        renameSync(`${target}.part`, target);
      } catch (error) {
        failed.push([row.name, url, (error as Error).message.replace(/\s+/g, ' ')].map((value) => `"${value.replace(/"/g, '""')}"`).join(','));
      }
      progress.tick();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  progress.finish();

  const failedCsv = join(out, 'failed.csv');
  if (failed.length) {
    mkdirSync(out, { recursive: true });
    writeFileSync(failedCsv, ['name,url,error', ...failed].join('\n') + '\n');
    console.log(`${failed.length} failed, listed in ${failedCsv}. Run again to retry them.`);
  } else {
    rmSync(failedCsv, { force: true });
    console.log('All files downloaded.');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
