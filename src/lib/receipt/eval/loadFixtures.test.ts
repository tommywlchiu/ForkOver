import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFixtures } from './loadFixtures';

const answer = {
  currency: 'JPY',
  items: [{ name: 'Ramen', quantity: 1, lineTotalCents: 900 }],
  discountCents: 0,
  taxCents: 90,
  fees: [],
  printedTipCents: null,
  printedSubtotalCents: 900,
  printedTotalCents: 990,
  kinds: ['non-usd'],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forkover-fixtures-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, content: string | object = 'x') =>
  writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));

describe('loadFixtures', () => {
  it('pairs each photo with its expected file, sorted by name, and reads the media type from the extension', () => {
    write('b.PNG', 'png-bytes');
    write('b.expected.json', answer);
    write('a.jpeg', 'jpeg-bytes');
    write('a.expected.json', answer);
    write('c.jpg');
    write('c.expected.json', answer);
    write('README.md', 'ignored');
    const { fixtures, problems } = loadFixtures(dir);
    expect(problems).toEqual([]);
    expect(fixtures.map((f) => [f.name, f.mediaType])).toEqual([
      ['a', 'image/jpeg'],
      ['b', 'image/png'],
      ['c', 'image/jpeg'],
    ]);
    expect(new TextDecoder().decode(fixtures[0].image)).toBe('jpeg-bytes');
    expect(fixtures[0].expected.currency).toBe('JPY');
    expect(fixtures[0].kinds).toEqual(['non-usd']);
  });

  it('is empty, with no problems, for a folder that only has a README', () => {
    write('README.md');
    expect(loadFixtures(dir)).toEqual({ fixtures: [], problems: [] });
  });

  it('lists every problem instead of stopping at the first', () => {
    write('nomatch.jpg');
    write('bad-json.jpg');
    write('bad-json.expected.json', '{not json');
    write('bad-shape.jpg');
    write('bad-shape.expected.json', { ...answer, currency: 'ZZZ' });
    write('orphan.expected.json', answer);
    write('dupe.jpg');
    write('dupe.png');
    write('dupe.expected.json', answer);
    const { fixtures, problems } = loadFixtures(dir);
    expect(fixtures.map((f) => f.name)).toEqual(['dupe']);
    expect(problems).toEqual(
      expect.arrayContaining([
        'nomatch.jpg: missing nomatch.expected.json',
        'bad-json.expected.json: not valid JSON',
        expect.stringContaining('bad-shape.expected.json: currency must be a known ISO 4217 code'),
        expect.stringContaining('orphan.expected.json: no photo named orphan'),
        'dupe.png: another photo is already named "dupe"',
      ]),
    );
    expect(problems).toHaveLength(5);
  });

  it('reports a missing folder', () => {
    const missing = join(dir, 'nope');
    expect(loadFixtures(missing).problems).toEqual([`fixtures directory not found: ${missing}`]);
    mkdirSync(missing);
    expect(loadFixtures(missing).problems).toEqual([]);
  });
});
