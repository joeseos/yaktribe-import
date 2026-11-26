import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyStats, type ConvertStats } from './bbcode.ts';

export interface StepReport {
  name: string;
  /** Rows read from XenForo */
  read: number;
  /** Rows written to Munda Manager */
  written: number;
  /** Rows left out, by reason */
  skipped: Record<string, number>;
}

/** One line of the image manifest: a file to copy from YakTribe into the bucket. */
export interface ImageFile {
  /** Path in the bucket, attachments/<attachment id>.webp */
  name: string;
  /** The full-size image on YakTribe */
  sourceUrl: string;
  /** The file on YakTribe's server, relative to the XenForo folder */
  filePath: string;
  /** Set when an add-on stored the file elsewhere */
  externalUrl: string;
  fileSize: number;
  filename: string;
}

const csvField = (value: unknown) => `"${String(value).replace(/"/g, '""')}"`;

export class Report {
  readonly startedAt = new Date();
  finishedAt: Date | null = null;
  dryRun = false;
  committed = false;
  error: string | null = null;
  readonly steps: StepReport[] = [];
  readonly notes: string[] = [];
  readonly conversion: ConvertStats = emptyStats();
  /** XenForo post ids whose converted HTML went over the 50,000 character limit */
  readonly truncatedPosts: number[] = [];

  step(name: string): StepReport {
    const step = { name, read: 0, written: 0, skipped: {} };
    this.steps.push(step);
    return step;
  }

  write(dir: string, images: ImageFile[] = []): { json: string; html: string; images: string | null } {
    mkdirSync(dir, { recursive: true });
    const stamp = this.startedAt.toISOString().replace(/[:.]/g, '-');
    const json = join(dir, `import-${stamp}.json`);
    const html = join(dir, `import-${stamp}.html`);
    writeFileSync(json, JSON.stringify(this, null, 2));
    writeFileSync(html, this.html());
    if (!images.length) return { json, html, images: null };
    const csv = join(dir, `images-${stamp}.csv`);
    const header = 'name,source_url,file_path,external_url,file_size,filename';
    const lines = images.map((image) =>
      [image.name, image.sourceUrl, image.filePath, image.externalUrl, image.fileSize, image.filename].map(csvField).join(','));
    writeFileSync(csv, `${[header, ...lines].join('\n')}\n`);
    return { json, html, images: csv };
  }

  private html(): string {
    const esc = (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const fmt = (n: number) => n.toLocaleString('en-US');
    const counts = (record: Record<string, number>) =>
      Object.entries(record)
        .sort((a, b) => b[1] - a[1])
        .map(([key, n]) => `${esc(key)}: ${fmt(n)}`)
        .join('<br>') || '–';
    const status = this.error ? `Failed: ${esc(this.error)}` : this.committed ? 'Committed' : 'Rolled back (dry run)';
    const seconds = this.finishedAt ? ((this.finishedAt.getTime() - this.startedAt.getTime()) / 1000).toFixed(1) : '?';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>YakTribe import report</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:32px auto;max-width:960px;padding:0 16px;color:#1d1d1b;background:#fafaf7}
table{border-collapse:collapse;width:100%;margin:16px 0}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}
td.n{text-align:right;font-variant-numeric:tabular-nums}.bad{color:#9b111a}
</style></head><body>
<h1>YakTribe import report</h1>
<p class="${this.error ? 'bad' : ''}"><b>${status}</b> · started ${esc(this.startedAt.toISOString())} · ${seconds}s</p>
<table><tr><th>Step</th><th>Read</th><th>Written</th><th>Skipped</th></tr>
${this.steps.map((s) => `<tr><td>${esc(s.name)}</td><td class="n">${fmt(s.read)}</td><td class="n">${fmt(s.written)}</td><td>${counts(s.skipped)}</td></tr>`).join('\n')}
</table>
<h2>BB code</h2>
<table>
<tr><td>Unknown tags (kept as text)</td><td>${counts(this.conversion.unknownTags)}</td></tr>
<tr><td>Converted with formatting lost</td><td>${counts(this.conversion.lossyTags)}</td></tr>
<tr><td>Images shown from the bucket</td><td>${fmt(this.conversion.imagesLinked)}</td></tr>
<tr><td>Attachments not migrated (files, or images from posts that aren't imported)</td><td>${fmt(this.conversion.attachmentsDropped)}</td></tr>
<tr><td>Gallery embeds not migrated (albums, private or members-only)</td><td>${fmt(this.conversion.galleryDropped)}</td></tr>
<tr><td>http:// images turned into links</td><td>${fmt(this.conversion.httpImagesLinked)}</td></tr>
<tr><td>Posts cut to fit 50,000 characters</td><td>${this.truncatedPosts.length ? esc(this.truncatedPosts.join(', ')) : '–'}</td></tr>
</table>
${this.notes.length ? `<h2>Notes</h2><ul>${this.notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>` : ''}
</body></html>
`;
  }
}
