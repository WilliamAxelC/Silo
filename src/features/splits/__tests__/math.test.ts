import {
  computeCustomSplit,
  computeEqualSplit,
  computeItemizedSplit,
  SELF_PARTICIPANT_ID,
} from '../math';

describe('split math engine', () => {
  describe('computeEqualSplit', () => {
    it('splits IDR (0-decimal) evenly and reconciles remainder to exact total', () => {
      const res = computeEqualSplit(100_000, ['a', 'b'], true, 'IDR');
      const total = res.shares.a + res.shares.b + res.selfShare;
      expect(total).toBe(100_000);
      expect(res.shares.a).toBe(33_334);
      expect(res.shares.b).toBe(33_333);
      expect(res.selfShare).toBe(33_333);
    });

    it('splits USD (2-decimal) evenly across participants only when includeSelf is false', () => {
      const res = computeEqualSplit(10, ['a', 'b', 'c'], false, 'USD');
      const total = Number((res.shares.a + res.shares.b + res.shares.c).toFixed(2));
      expect(total).toBe(10);
      expect(res.selfShare).toBe(0);
      expect(res.shares).toEqual({ a: 3.34, b: 3.33, c: 3.33 });
    });

    it('returns empty shares when no participants and includeSelf is false', () => {
      expect(computeEqualSplit(50_000, [], false, 'IDR')).toEqual({ shares: {}, selfShare: 0 });
    });
  });

  describe('computeCustomSplit', () => {
    it('detects balanced and unbalanced custom splits including self share', () => {
      const unbalanced = computeCustomSplit(
        100_000,
        { a: 40_000, [SELF_PARTICIPANT_ID]: 35_000 },
        true,
        'IDR'
      );
      expect(unbalanced.isBalanced).toBe(false);
      expect(unbalanced.remaining).toBe(25_000);
      expect(unbalanced.othersTotal).toBe(40_000);
      expect(unbalanced.selfShare).toBe(35_000);

      const balanced = computeCustomSplit(
        100_000,
        { a: 40_000, b: 25_000, [SELF_PARTICIPANT_ID]: 35_000 },
        true,
        'IDR'
      );
      expect(balanced.isBalanced).toBe(true);
      expect(balanced.remaining).toBe(0);
    });
  });

  describe('computeItemizedSplit', () => {
    it('assigns single & shared items and prorates tax/service proportionally', () => {
      // Total bill = 120,000; items = 100,000; tax & service = 20,000 (20%)
      const items = [
        { id: '1', name: 'Nasi Goreng', price: 40_000 }, // Budi
        { id: '2', name: 'Ramen', price: 40_000 }, // Me
        { id: '3', name: 'Edamame', price: 20_000 }, // Shared Budi + Me (10k each)
      ];
      const res = computeItemizedSplit(
        120_000,
        items,
        {
          '1': ['budi'],
          '2': [SELF_PARTICIPANT_ID],
          '3': ['budi', SELF_PARTICIPANT_ID],
        },
        ['budi'],
        true,
        'IDR'
      );

      expect(res.unassignedItemIds).toEqual([]);
      expect(res.itemsSubtotal).toBe(100_000);
      expect(res.adjustmentTotal).toBe(20_000);
      // Both Budi and Me have 50k items -> 10k tax each -> 60k total each
      expect(res.shares.budi).toBe(60_000);
      expect(res.selfShare).toBe(60_000);
      expect(res.breakdowns.budi).toEqual({
        items: [
          { name: 'Nasi Goreng', fullPrice: 40_000, shareAmount: 40_000, sharedWithCount: 1 },
          { name: 'Edamame', fullPrice: 20_000, shareAmount: 10_000, sharedWithCount: 2 },
        ],
        adjustmentAmount: 10_000,
        adjustmentLabel: 'Tax & fees',
        includeSelf: true,
        totalParticipants: 2,
      });
    });

    it('prorates negative discounts proportionally and tracks unassigned items', () => {
      const items = [
        { id: '1', name: 'Pizza', price: 30 },
        { id: '2', name: 'Pasta', price: 10 },
      ];
      // Total after $8 discount = $32
      const res = computeItemizedSplit(
        32,
        items,
        { '1': ['alice'], '2': ['bob'] },
        ['alice', 'bob'],
        false,
        'USD'
      );
      expect(res.unassignedItemIds).toEqual([]);
      expect(res.adjustmentTotal).toBe(-8);
      // Alice gets 75% of -$8 (-$6) -> $24; Bob gets 25% of -$8 (-$2) -> $8
      expect(res.shares.alice).toBe(24);
      expect(res.shares.bob).toBe(8);
      expect(res.breakdowns.alice.adjustmentLabel).toBe('Discount');
      expect(res.breakdowns.alice.adjustmentAmount).toBe(-6);

      const partial = computeItemizedSplit(
        32,
        items,
        { '1': ['alice'] },
        ['alice', 'bob'],
        false,
        'USD'
      );
      expect(partial.unassignedItemIds).toEqual(['2']);
    });

    it('reconciles fractional proration pennies to exact total', () => {
      const items = [
        { id: '1', name: 'A', price: 10 },
        { id: '2', name: 'B', price: 10 },
        { id: '3', name: 'C', price: 10 },
      ];
      const res = computeItemizedSplit(
        35,
        items,
        { '1': ['a'], '2': ['b'], '3': ['c'] },
        ['a', 'b', 'c'],
        false,
        'USD'
      );
      const sum = Number((res.shares.a + res.shares.b + res.shares.c).toFixed(2));
      expect(sum).toBe(35);
    });
  });
});
