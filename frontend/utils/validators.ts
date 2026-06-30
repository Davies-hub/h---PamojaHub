export function validatePhone(phone: string): string | undefined {
  const clean = phone.replace(/[\s-]/g, '');
  if (!clean) return 'Phone number is required';
  if (!/^(07|01)\d{8}$/.test(clean)) {
    return 'Enter a valid Safaricom number (e.g. 0712 345 678)';
  }
}

export function validateAmount(amount: string | number): string | undefined {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (!num || isNaN(num)) return 'Amount is required';
  if (num < 5) return 'Minimum amount is KES 5';
  if (num > 150000) return 'Maximum amount is KES 150,000';
}

export function normalizePhone(phone: string): string {
  const clean = phone.replace(/[\s-]/g, '');
  if (clean.startsWith('0')) return '254' + clean.slice(1);
  if (clean.startsWith('+')) return clean.slice(1);
  return clean;
}
