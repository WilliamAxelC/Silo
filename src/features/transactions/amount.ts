export function formatAmountInput(text: string): string {
  const numericValue = text.replace(/[^0-9]/g, '');
  return numericValue.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function parseSignedAmount(value: string, type: 'income' | 'expense'): number {
  const parsedAmount = parseFloat(value.replace(/,/g, ''));
  return type === 'expense' ? -Math.abs(parsedAmount) : Math.abs(parsedAmount);
}
