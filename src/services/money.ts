export function getCommissionRateBps(partnerRateBps?: number | null): number {
  const configuredRate = process.env.DEFAULT_COMMISSION_BPS ?? '1000';
  const defaultRateBps = Number(configuredRate);

  if (!Number.isSafeInteger(defaultRateBps) || defaultRateBps < 0 || defaultRateBps > 10_000) {
    throw new Error('DEFAULT_COMMISSION_BPS must be an integer between 0 and 10000');
  }

  const rateBps = partnerRateBps ?? defaultRateBps;
  if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new Error('Supplier commission rate must be an integer between 0 and 10000 basis points');
  }

  return rateBps;
}

export function calculateCommissionKobo(amountKobo: number, rateBps: number): number {
  if (!Number.isSafeInteger(amountKobo) || amountKobo < 0) {
    throw new Error('Amount must be a non-negative integer number of kobo');
  }
  if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new Error('Commission rate must be an integer between 0 and 10000 basis points');
  }

  return Math.floor((amountKobo * rateBps) / 10_000);
}
