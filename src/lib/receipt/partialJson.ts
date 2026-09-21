/**
 * Incremental parsing of the model's streamed JSON text so each line item can
 * be shown the moment its object closes. See SPEC.md section 7.1.
 *
 * This file is imported by the app and by the parse-receipt Edge Function
 * (Deno), so it must stay dependency-free.
 */

export type ItemStreamParser = {
  /** Feeds the next text chunk and returns the items whose objects just closed. */
  push(chunk: string): unknown[];
  /** Everything fed so far. */
  readonly text: string;
};

type Frame = {
  kind: 'object' | 'array';
  /** Key this container sits under in its parent object, if any. */
  key: string | null;
  /** Object frames only: the next string token is a key, not a value. */
  expectKey: boolean;
};

/**
 * Watches a streamed `ParsedReceipt` JSON document and emits each element of the
 * top-level `items` array once its closing brace arrives. Chunks may split
 * anywhere, including inside a string or an escape sequence. An item that
 * doesn't parse is skipped; the final `validateReceipt` on the full text is the
 * authority on whether the output was usable.
 */
export function createItemStreamParser(): ItemStreamParser {
  let text = '';
  const stack: Frame[] = [];
  let inString = false;
  let escaped = false;
  let stringIsKey = false;
  let stringStart = 0;
  let lastKey: string | null = null;
  let itemStart = -1;

  const inItemsArray = () => stack.length >= 2 && stack[1].kind === 'array' && stack[1].key === 'items';

  const push = (chunk: string): unknown[] => {
    const offset = text.length;
    text += chunk;
    const emitted: unknown[] = [];

    for (let i = offset; i < text.length; i++) {
      const char = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
          if (stringIsKey) {
            try {
              lastKey = JSON.parse(text.slice(stringStart, i + 1)) as string;
            } catch {
              lastKey = null;
            }
          }
        }
        continue;
      }

      const top = stack[stack.length - 1];
      switch (char) {
        case '"':
          inString = true;
          stringStart = i;
          stringIsKey = top?.kind === 'object' && top.expectKey;
          break;
        case ':':
          if (top?.kind === 'object') top.expectKey = false;
          break;
        case ',':
          if (top?.kind === 'object') top.expectKey = true;
          break;
        case '{':
        case '[': {
          const key = top?.kind === 'object' ? lastKey : null;
          stack.push({ kind: char === '{' ? 'object' : 'array', key, expectKey: char === '{' });
          if (char === '{' && stack.length === 3 && inItemsArray()) itemStart = i;
          break;
        }
        case '}':
        case ']': {
          stack.pop();
          if (char === '}' && stack.length === 2 && inItemsArray() && itemStart >= 0) {
            try {
              emitted.push(JSON.parse(text.slice(itemStart, i + 1)));
            } catch {
              // Skipped; see the doc comment.
            }
            itemStart = -1;
          }
          break;
        }
        default:
          break;
      }
    }
    return emitted;
  };

  return {
    push,
    get text() {
      return text;
    },
  };
}
