/**
 * Reads `fixtures/receipts/`: each photo (`.jpg`, `.jpeg`, `.png`) needs a
 * `<name>.expected.json` beside it. Problems are collected, not thrown, so the
 * script can list every one before it spends anything on the API.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImageMediaType } from '../anthropic.ts';
import { parseExpectedFile } from './expected.ts';
import type { EvalFixture } from './types.ts';

const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

export const EXPECTED_SUFFIX = '.expected.json';

export function loadFixtures(dir: string): { fixtures: EvalFixture[]; problems: string[] } {
  if (!existsSync(dir)) return { fixtures: [], problems: [`fixtures directory not found: ${dir}`] };

  const problems: string[] = [];
  const fixtures: EvalFixture[] = [];
  const files = readdirSync(dir).sort();
  const photoNames = new Set<string>();

  for (const file of files) {
    const match = /^(.+)\.(jpe?g|png)$/i.exec(file);
    if (!match) continue;
    const [, name, extension] = match;
    if (photoNames.has(name)) {
      problems.push(`${file}: another photo is already named "${name}"`);
      continue;
    }
    photoNames.add(name);

    const expectedFile = `${name}${EXPECTED_SUFFIX}`;
    if (!files.includes(expectedFile)) {
      problems.push(`${file}: missing ${expectedFile}`);
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(join(dir, expectedFile), 'utf8'));
    } catch {
      problems.push(`${expectedFile}: not valid JSON`);
      continue;
    }
    const parsed = parseExpectedFile(json);
    if (!parsed.ok) {
      problems.push(...parsed.errors.map((error) => `${expectedFile}: ${error}`));
      continue;
    }
    fixtures.push({
      name,
      image: new Uint8Array(readFileSync(join(dir, file))),
      mediaType: IMAGE_EXTENSIONS[extension.toLowerCase()],
      expected: parsed.file.expected,
      kinds: parsed.file.kinds,
    });
  }

  for (const file of files) {
    if (file.endsWith(EXPECTED_SUFFIX) && !photoNames.has(file.slice(0, -EXPECTED_SUFFIX.length))) {
      problems.push(`${file}: no photo named ${file.slice(0, -EXPECTED_SUFFIX.length)}.jpg, .jpeg, or .png beside it`);
    }
  }
  return { fixtures, problems };
}
