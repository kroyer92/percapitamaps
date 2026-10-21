import countries from 'i18n-iso-countries';
export function numericToIso3(n: string): string | undefined {
  return countries.numericToAlpha3(n);
}
