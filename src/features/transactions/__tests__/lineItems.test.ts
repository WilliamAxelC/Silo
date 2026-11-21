import {
  createReceiptItemDraft,
  parseReceiptLineItemsText,
  serializeReceiptLineItems,
} from '../lineItems';

describe('receipt line items serializer & parser (F-01)', () => {
  it('round-trips items without notes with zero trailing pipe characters', () => {
    const drafts = [
      createReceiptItemDraft({ id: '1', name: 'Latte', price: '30.000', note: '' }),
      createReceiptItemDraft({ id: '2', name: 'Croissant', price: '15.000', note: '' }),
    ];

    const serialized = serializeReceiptLineItems(drafts);
    expect(serialized).toBe('Latte | 30.000\nCroissant | 15.000');
    expect(serialized).not.toContain(' | \n');
    expect(serialized.endsWith('|')).toBe(false);

    const parsed = parseReceiptLineItemsText(serialized);
    expect(parsed.map(({ name, price, note }) => ({ name, price, note }))).toEqual([
      { name: 'Latte', price: '30.000', note: '' },
      { name: 'Croissant', price: '15.000', note: '' },
    ]);

    // Second round-trip is bit-for-bit identical
    expect(serializeReceiptLineItems(parsed)).toBe(serialized);
  });

  it('round-trips mixed items with notes, without notes, and notes containing pipes', () => {
    const drafts = [
      { name: 'Latte', price: '30.000', note: 'oat milk | less ice' },
      { name: 'Croissant', price: '15.000', note: '' },
      { name: 'Free water', price: '', note: '' },
      { name: 'Discounted pastry', price: '', note: 'promo' },
    ];

    const serialized = serializeReceiptLineItems(drafts);
    expect(serialized).toBe(
      'Latte | 30.000 | oat milk \\| less ice\nCroissant | 15.000\nFree water\nDiscounted pastry |  | promo'
    );

    const parsed = parseReceiptLineItemsText(serialized);
    expect(parsed.map(({ name, price, note }) => ({ name, price, note }))).toEqual(drafts);
    expect(serializeReceiptLineItems(parsed)).toBe(serialized);
  });

  it('round-trips names and notes containing pipes, newlines, backslashes, tight pipes, and priceless dash-numbers (R3A-02)', () => {
    const drafts = [
      { name: 'Fish | Chips', price: '50.000', note: '' },
      { name: 'Combo\nMeal', price: '45.000', note: 'Line 1\nLine 2' },
      { name: 'Iced Latte', price: '32.000', note: 'oat|ice' },
      { name: 'Combo - 1', price: '', note: '' },
      { name: 'Back\\slash | Item', price: '12.500', note: 'path\\nliteral | ok' },
    ];

    const serialized = serializeReceiptLineItems(drafts);
    // One physical serialized row per item (no embedded newline splitting)
    expect(serialized.split('\n')).toHaveLength(drafts.length);

    const parsed = parseReceiptLineItemsText(serialized);
    expect(parsed.map(({ name, price, note }) => ({ name, price, note }))).toEqual(drafts);

    // Second round-trip is bit-for-bit identical
    expect(serializeReceiptLineItems(parsed)).toBe(serialized);
  });

  it('remains backward-compatible with legacy unescaped pipes in notes, trailing pipes, and dash syntax (R3A-02)', () => {
    const legacy = [
      'Latte | 30.000 |',
      'Croissant | 15.000 |',
      'Matcha | 35.000 | oat|ice',
      'Americano | 25.000 | hot | no sugar',
      'Nasi Goreng - 25.000',
    ].join('\n');

    const parsed = parseReceiptLineItemsText(legacy);
    expect(parsed.map(({ name, price, note }) => ({ name, price, note }))).toEqual([
      { name: 'Latte', price: '30.000', note: '' },
      { name: 'Croissant', price: '15.000', note: '' },
      { name: 'Matcha', price: '35.000', note: 'oat|ice' },
      { name: 'Americano', price: '25.000', note: 'hot | no sugar' },
      { name: 'Nasi Goreng', price: '25.000', note: '' },
    ]);
  });

  it('cleanly recovers legacy corrupted trailing-pipe strings without leaking " |" into price', () => {
    const legacy = 'Latte | 30.000 |\nCroissant | 15.000 |';
    const parsed = parseReceiptLineItemsText(legacy);

    expect(parsed.map(({ name, price, note }) => ({ name, price, note }))).toEqual([
      { name: 'Latte', price: '30.000', note: '' },
      { name: 'Croissant', price: '15.000', note: '' },
    ]);
    expect(serializeReceiptLineItems(parsed)).toBe('Latte | 30.000\nCroissant | 15.000');
  });

  it('supports legacy dash-separated lines and skips empty items', () => {
    const parsed = parseReceiptLineItemsText('Nasi Goreng - 25.000\n\n   ');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ name: 'Nasi Goreng', price: '25.000', note: '' });

    expect(serializeReceiptLineItems([{ name: '  ', price: '', note: '' }])).toBe('');
    expect(parseReceiptLineItemsText('')).toEqual([]);
  });
});
