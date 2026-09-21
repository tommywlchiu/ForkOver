import { createItemStreamParser } from './partialJson';
import { sampleReceipt } from './fixtures';

const feedAll = (chunks: string[]) => {
  const parser = createItemStreamParser();
  const emitted: unknown[] = [];
  for (const chunk of chunks) emitted.push(...parser.push(chunk));
  return { parser, emitted };
};

const chunked = (text: string, size: number) => {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
};

describe('createItemStreamParser', () => {
  const json = JSON.stringify(sampleReceipt);

  it('emits every item of a document delivered whole', () => {
    expect(feedAll([json]).emitted).toEqual(sampleReceipt.items);
  });

  it('emits the same items however the text is chunked, including one character at a time', () => {
    for (const size of [1, 2, 3, 7, 31]) {
      expect(feedAll(chunked(json, size)).emitted).toEqual(sampleReceipt.items);
    }
  });

  it('emits an item only once its closing brace arrives', () => {
    const parser = createItemStreamParser();
    expect(parser.push('{"isReceipt":true,"items":[{"name":"Beer","quantity":1,')).toEqual([]);
    expect(parser.push('"lineTotalCents":500')).toEqual([]);
    expect(parser.push('},{"name":"Fri')).toEqual([{ name: 'Beer', quantity: 1, lineTotalCents: 500 }]);
    expect(parser.push('es","quantity":1,"lineTotalCents":300}]')).toEqual([
      { name: 'Fries', quantity: 1, lineTotalCents: 300 },
    ]);
  });

  it('emits each item exactly once', () => {
    const parser = createItemStreamParser();
    const first = parser.push('{"items":[{"name":"A","quantity":1,"lineTotalCents":1}]');
    const second = parser.push(',"fees":[{"label":"x","cents":1}]}');
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it('is not confused by braces, brackets, quotes, and commas inside strings', () => {
    const tricky = {
      items: [
        { name: 'Combo {"a": [1, 2]} \\ "quoted"', quantity: 1, lineTotalCents: 100 },
        { name: '] } , "items": [', quantity: 2, lineTotalCents: 200 },
      ],
    };
    const text = JSON.stringify(tricky);
    for (const size of [1, 5, text.length]) {
      expect(feedAll(chunked(text, size)).emitted).toEqual(tricky.items);
    }
  });

  it('handles unicode and escape sequences split across chunks', () => {
    const item = { name: 'Café é \n tab\t 🍺', quantity: 1, lineTotalCents: 1 };
    const text = JSON.stringify({ items: [item] });
    expect(feedAll(chunked(text, 1)).emitted).toEqual([item]);
  });

  it('ignores objects in other arrays such as fees', () => {
    const text = JSON.stringify({ fees: [{ label: 'x', cents: 1 }], items: [], warnings: [] });
    expect(feedAll([text]).emitted).toEqual([]);
  });

  it('ignores an items key nested deeper than the top level', () => {
    const text = JSON.stringify({ meta: { items: [{ name: 'no' }] }, items: [{ name: 'yes' }] });
    expect(feedAll([text]).emitted).toEqual([{ name: 'yes' }]);
  });

  it('handles an empty items array and tolerates whitespace and fences around the JSON', () => {
    expect(feedAll(['{ "items" : [ ] }']).emitted).toEqual([]);
    const fenced = '```json\n{\n  "items": [\n    { "name": "A", "quantity": 1, "lineTotalCents": 5 }\n  ]\n}\n```';
    expect(feedAll(chunked(fenced, 4)).emitted).toEqual([{ name: 'A', quantity: 1, lineTotalCents: 5 }]);
  });

  it('skips an item that is not valid JSON and keeps going', () => {
    const { emitted } = feedAll(['{"items":[{"name":oops},{"name":"B"}]}']);
    expect(emitted).toEqual([{ name: 'B' }]);
  });

  it('exposes everything fed so far as text', () => {
    const { parser } = feedAll(['{"a":', '1}']);
    expect(parser.text).toBe('{"a":1}');
  });

  it('emits nothing for a truncated stream before the first item closes', () => {
    expect(feedAll(['{"isReceipt":true,"items":[{"name":"Be']).emitted).toEqual([]);
  });
});
