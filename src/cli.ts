import { parseArgs } from 'node:util';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { Importer } from './import.ts';
import { loadMapping } from './mapping.ts';
import { Report } from './report.ts';

const usage = `Usage: npm run import -- [--dry-run] [--limit-threads N] [--batch-size N]

  --dry-run          Run every step, then roll back: Munda Manager is left as it was
  --limit-threads N  Import only the first N threads
  --batch-size N     Threads per batch (default 500)

Settings come from the environment or .env:
  XF_DATABASE_URL    mysql://user:password@host:3306/xenforo
  MM_DATABASE_URL    postgresql://postgres:password@host:5432/postgres
  XF_TABLE_PREFIX    default xf_
  MAPPING            default mapping.csv
  REPORT_DIR         default reports`;

function positive(name: string, value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`--${name} must be a whole number above 0`);
  return Number(value);
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Add it to .env or the environment.`);
  return value;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      'limit-threads': { type: 'string' },
      'batch-size': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }

  const mapping = loadMapping(process.env.MAPPING || 'mapping.csv');
  const options = {
    prefix: process.env.XF_TABLE_PREFIX || 'xf_',
    batchSize: positive('batch-size', values['batch-size']) ?? 500,
    limitThreads: positive('limit-threads', values['limit-threads']),
  };
  const report = new Report();
  report.dryRun = values['dry-run'];

  const xf = await mysql.createConnection({ uri: env('XF_DATABASE_URL'), charset: 'utf8mb4' });
  const mm = new pg.Client({ connectionString: env('MM_DATABASE_URL') });
  await mm.connect();
  try {
    await new Importer(xf, mm, mapping, report, options).run(report.dryRun);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    report.finishedAt = new Date();
    await Promise.allSettled([xf.end(), mm.end()]);
  }

  const files = report.write(process.env.REPORT_DIR || 'reports');
  console.log(report.error ? `\nImport failed: ${report.error}` : report.committed ? '\nImport committed.' : '\nDry run finished, nothing was saved.');
  console.log(`Report: ${files.html}\n        ${files.json}`);
  if (report.error) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  console.error(`\n${usage}`);
  process.exitCode = 1;
});
