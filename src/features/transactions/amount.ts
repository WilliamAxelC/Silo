export function formatAmountInput(text: string): string {
  if (!text) return '';
  const numericValue = text.replace(/[^0-9]/g, '');
  if (!numericValue) return '';
  return numericValue.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function parseSignedAmount(value: string | number | null | undefined, type: 'income' | 'expense'): number {
  if (value === null || value === undefined || value === '') return 0;
  const numStr = typeof value === 'number' ? String(value) : value.replace(/,/g, '').trim();
  const parsed = parseFloat(numStr);
  if (isNaN(parsed)) return 0;
  return type === 'expense' ? -Math.abs(parsed) : Math.abs(parsed);
}

export function formatDisplayCurrency(
  amount: number | null | undefined,
  currencyCode = 'IDR',
  useThousands = true
): string {
  const safeAmount = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
  if (!useThousands) {
    return `${currencyCode === 'IDR' ? 'Rp' : currencyCode} ${safeAmount}`;
  }

  try {
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: currencyCode || 'IDR',
      maximumFractionDigits: currencyCode === 'IDR' ? 0 : 2,
    }).format(safeAmount);
  } catch {
    return `${currencyCode} ${safeAmount.toLocaleString('en-US')}`;
  }
}
