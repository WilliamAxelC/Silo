import {
  buildWhatsAppUrl,
  formatGroupSummaryMessage,
  formatPersonBillMessage,
  formatPersonCombinedMessage,
  inferCountryCodeFromCurrency,
  normalizePhoneForWhatsApp,
} from '../messaging';

describe('split messaging & WhatsApp helpers', () => {
  it('infers calling codes from common currencies', () => {
    expect(inferCountryCodeFromCurrency('IDR')).toBe('62');
    expect(inferCountryCodeFromCurrency('USD')).toBe('1');
    expect(inferCountryCodeFromCurrency('SGD')).toBe('65');
  });

  it('normalizes local, +prefixed, and invalid phone numbers for WhatsApp', () => {
    expect(normalizePhoneForWhatsApp('0812-3456-7890', '62')).toBe('6281234567890');
    expect(normalizePhoneForWhatsApp('+62 812 3456 7890', '62')).toBe('6281234567890');
    expect(normalizePhoneForWhatsApp('0065 9123 4567', '62')).toBe('6591234567');
    expect(normalizePhoneForWhatsApp('123', '62')).toBeNull();
    expect(normalizePhoneForWhatsApp('', '62')).toBeNull();
  });

  it('builds wa.me URL with phone when valid and falls back to phone-less wa.me when absent', () => {
    const withPhone = buildWhatsAppUrl('Hi Budi!', '08123456789', '62');
    expect(withPhone).toBe('https://wa.me/628123456789?text=Hi%20Budi!');

    const withoutPhone = buildWhatsAppUrl('Hi Budi!', null, '62');
    expect(withoutPhone).toBe('https://wa.me/?text=Hi%20Budi!');
  });

  it('formats an itemized person bill message with payment details', () => {
    const msg = formatPersonBillMessage({
      personName: 'Budi',
      merchantName: 'Ramen Ya',
      date: new Date('2026-11-20T12:00:00Z').getTime(),
      billTotal: 120_000,
      amountOwed: 60_000,
      currency: 'IDR',
      splitMode: 'items',
      breakdown: {
        items: [
          { name: 'Spicy Ramen', fullPrice: 40_000, shareAmount: 40_000, sharedWithCount: 1 },
          { name: 'Gyoza', fullPrice: 20_000, shareAmount: 10_000, sharedWithCount: 2 },
        ],
        adjustmentAmount: 10_000,
        adjustmentLabel: 'Tax & fees',
      },
      paymentDetails: 'BCA 1234567890 a.n. William',
      locale: 'en-GB',
      useThousandsSeparator: true,
    });

    expect(msg).toContain('Hi Budi');
    expect(msg).toContain('Ramen Ya');
    expect(msg).toContain('Spicy Ramen');
    expect(msg).toContain('Gyoza (split 2 ways)');
    expect(msg).toContain('Tax & fees');
    expect(msg).toContain('Your share:');
    expect(msg).toContain('60.000');
    expect(msg).toContain('Payment details:');
    expect(msg).toContain('BCA 1234567890 a.n. William');
  });

  it('formats a group summary and combined multi-bill reminder without trailing payment block when empty', () => {
    const groupMsg = formatGroupSummaryMessage({
      merchantName: 'Pizza Place',
      date: new Date('2026-11-20T12:00:00Z').getTime(),
      billTotal: 30,
      currency: 'USD',
      entries: [
        { personName: 'Alice', amountOwed: 10, isSettled: true },
        { personName: 'Bob', amountOwed: 10, isSettled: false },
      ],
      paymentDetails: '',
      locale: 'en-GB',
      useThousandsSeparator: true,
    });
    expect(groupMsg).toContain('Split bill: Pizza Place');
    expect(groupMsg).toContain('Alice');
    expect(groupMsg).toContain('[Paid]');
    expect(groupMsg).toContain('Bob');
    expect(groupMsg).toContain('Paid by me (my share)');
    expect(groupMsg).not.toContain('Payment details:');

    const combinedMsg = formatPersonCombinedMessage({
      personName: 'Bob',
      entries: [
        { merchantName: 'Coffee', transactionDate: new Date('2026-11-18T10:00:00Z').getTime(), amountOwed: 25_000, currency: 'IDR' },
        { merchantName: 'Lunch', transactionDate: new Date('2026-11-19T12:00:00Z').getTime(), amountOwed: 50_000, currency: 'IDR' },
      ],
      paymentDetails: 'GoPay 0812345',
    });
    expect(combinedMsg).toContain('Hi Bob');
    expect(combinedMsg).toContain('Coffee');
    expect(combinedMsg).toContain('Lunch');
    expect(combinedMsg).toContain('Total owed:');
    expect(combinedMsg).toContain('75.000');
    expect(combinedMsg).toContain('GoPay 0812345');
  });
});
