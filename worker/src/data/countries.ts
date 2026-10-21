import countries from 'i18n-iso-countries';
import en from 'i18n-iso-countries/langs/en.json' with { type: 'json' };

countries.registerLocale(en as any);

const alpha3 = countries.getAlpha3Codes(); // { AFG: 'AF', ... }
export const ISO3 = new Set(Object.keys(alpha3));

// Short, familiar names for on-screen text and narration.
const SHORT: Record<string, string> = {
  USA: 'United States', GBR: 'United Kingdom', RUS: 'Russia', KOR: 'South Korea', PRK: 'North Korea',
  IRN: 'Iran', SYR: 'Syria', VNM: 'Vietnam', LAO: 'Laos', BOL: 'Bolivia', VEN: 'Venezuela',
  TZA: 'Tanzania', COD: 'DR Congo', COG: 'Congo', CIV: "Côte d'Ivoire", MDA: 'Moldova',
  CZE: 'Czechia', MKD: 'North Macedonia', TWN: 'Taiwan', BRN: 'Brunei', FSM: 'Micronesia',
  PSE: 'Palestine', CPV: 'Cape Verde', SWZ: 'Eswatini', TUR: 'Turkey', NLD: 'Netherlands',
  ARE: 'UAE', DOM: 'Dominican Republic', CAF: 'Central African Republic', BHS: 'Bahamas',
  GMB: 'Gambia', VAT: 'Vatican City', HKG: 'Hong Kong', MAC: 'Macao',
  EGY: 'Egypt', YEM: 'Yemen', SVK: 'Slovakia', KGZ: 'Kyrgyzstan', FLK: 'Falkland Islands',
  VGB: 'British Virgin Islands', KNA: 'St Kitts and Nevis', VCT: 'St Vincent', LCA: 'St Lucia',
  STP: 'São Tomé and Príncipe', TLS: 'Timor-Leste', BIH: 'Bosnia and Herzegovina', SPM: 'St Pierre and Miquelon',
  MAF: 'St Martin', SXM: 'Sint Maarten', VIR: 'US Virgin Islands', PNG: 'Papua New Guinea',
};

export function countryName(iso3: string, fallback?: string): string {
  if (SHORT[iso3]) return SHORT[iso3];
  // Source names like "Korea, Rep." or "Iran (Islamic Republic of)" read badly on screen.
  if (fallback && fallback.length <= 24 && !/[,()]/.test(fallback)) return fallback;
  const name = countries.getName(iso3, 'en', { select: 'alias' }) ?? countries.getName(iso3, 'en') ?? fallback ?? iso3;
  return name.replace(/\s*\(.*\)$/, '').replace(/,.*$/, '');
}

export function iso3ToIso2(iso3: string): string | undefined {
  return alpha3[iso3 as keyof typeof alpha3] as string | undefined;
}

export function numericToIso3(numeric: string): string | undefined {
  return countries.numericToAlpha3(numeric);
}

// Relatability anchors: viewers look for their own country.
export const ANCHORS = ['USA', 'GBR', 'CAN', 'AUS', 'IND', 'DEU'];
