import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function packageFile(): string {
  try {
    return fileURLToPath(new URL('../package.json', import.meta.url));
  } catch {
    return join(process.cwd(), 'package.json');
  }
}

const parsed = JSON.parse(readFileSync(packageFile(), 'utf8')) as { version?: unknown };

if (typeof parsed.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(parsed.version)) {
  throw new Error('package.json has no valid version');
}

/** The installed package version; release metadata must match this exactly. */
export const BOOKFISH_VERSION: string = parsed.version;
