export type ReceiptLineItemDraft = {
  id: string;
  name: string;
  price: string;
  note: string;
};

export function createReceiptItemDraft(overrides?: Partial<ReceiptLineItemDraft>): ReceiptLineItemDraft {
  return {
    id: overrides?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: overrides?.name ?? '',
    price: overrides?.price ?? '',
    note: overrides?.note ?? '',
  };
}

const LEGACY_DASH_PRICE_REGEX = /^(.*?)\s*-\s*([\d.,]+)$/;

function escapeLineItemField(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function unescapeLineItemField(value: string): string {
  if (!value.includes('\\')) {
    return value;
  }
  let result = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === '\\') {
        result += '\\';
        i += 1;
        continue;
      }
      if (next === '|') {
        result += '|';
        i += 1;
        continue;
      }
      if (next === 'n') {
        result += '\n';
        i += 1;
        continue;
      }
      if (next === 'r') {
        result += '\r';
        i += 1;
        continue;
      }
    }
    result += ch;
  }
  return result;
}

/**
 * Returns indices of unescaped `|` delimiters in a serialized line item row.
 */
function findUnescapedPipeIndices(line: string): number[] {
  const indices: number[] = [];
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      // Skip escaped character (e.g. `\|` or `\\`)
      i += 1;
      continue;
    }
    if (ch === '|') {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Parses persisted newline-separated receipt line items (`Name | Price` or `Name | Price | Note`).
 * Unescapes `\|`, `\n`, `\r`, and `\\` produced by `serializeReceiptLineItems` while remaining
 * backward-compatible with legacy unescaped `" | "` rows, trailing `" |"` corruption, and `"Name - Price"` rows.
 */
export function parseReceiptLineItemsText(value: string): ReceiptLineItemDraft[] {
  if (!value || !value.trim()) {
    return [];
  }

  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const pipeIndices = findUnescapedPipeIndices(line);
      if (pipeIndices.length > 0) {
        const firstPipe = pipeIndices[0];
        const secondPipe = pipeIndices.length > 1 ? pipeIndices[1] : -1;

        const rawName = line.slice(0, firstPipe).trim();
        const rawPrice =
          secondPipe === -1
            ? line.slice(firstPipe + 1).trim()
            : line.slice(firstPipe + 1, secondPipe).trim();
        const rawNote = secondPipe === -1 ? '' : line.slice(secondPipe + 1).trim();

        return createReceiptItemDraft({
          id: `${index}-${line}`,
          name: unescapeLineItemField(rawName),
          price: unescapeLineItemField(rawPrice),
          note: unescapeLineItemField(rawNote),
        });
      }

      const fallbackMatch = line.match(LEGACY_DASH_PRICE_REGEX);
      return createReceiptItemDraft({
        id: `${index}-${line}`,
        name: unescapeLineItemField(fallbackMatch ? fallbackMatch[1].trim() : line),
        price: unescapeLineItemField(fallbackMatch ? fallbackMatch[2].trim() : ''),
        note: '',
      });
    });
}

/**
 * Serializes receipt line item drafts to newline-separated text with unambiguous delimiter escaping.
 * Round-trips cleanly with `parseReceiptLineItemsText` for names/notes containing `|`, newlines,
 * backslashes, or dash-number patterns like `"Combo - 1"`, without emitting trailing delimiters for normal rows.
 */
export function serializeReceiptLineItems(items: ReadonlyArray<Pick<ReceiptLineItemDraft, 'name' | 'price' | 'note'>>): string {
  return items
    .map((item) => {
      const name = item.name.trim();
      const price = item.price.trim();
      const note = item.note.trim();

      if (!name && !price && !note) {
        return '';
      }

      const escapedName = escapeLineItemField(name);
      const escapedPrice = escapeLineItemField(price);
      const escapedNote = escapeLineItemField(note);

      if (escapedNote) {
        return `${escapedName} | ${escapedPrice} | ${escapedNote}`;
      }
      if (escapedPrice) {
        return `${escapedName} | ${escapedPrice}`;
      }
      // Disambiguate priceless names matching legacy "Name - 123" syntax so they don't split on reload.
      if (LEGACY_DASH_PRICE_REGEX.test(escapedName)) {
        return `${escapedName} |`;
      }
      return escapedName;
    })
    .filter(Boolean)
    .join('\n');
}
