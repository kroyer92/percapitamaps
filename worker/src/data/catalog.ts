// The dataset catalog: about 150 open indicators the pipeline may build videos from.
// `npm run migrate` loads it and `npm run check-datasets` verifies every entry against
// the live source, so an entry whose slug or license doesn't check out is disabled
// automatically rather than breaking a render.

export type SourceRef =
  | { kind: 'owid'; slugs: string[]; column?: string }
  | { kind: 'worldbank'; indicator: string }
  | { kind: 'ratio'; num: SourceRef; den: SourceRef; mult?: number }
  | { kind: 'reciprocal'; of: SourceRef; mult: number }
  | { kind: 'scale'; of: SourceRef; mult: number };

export interface CatalogEntry {
  id: string;
  title: string;          // what the number is, e.g. "Annual working hours per worker"
  unit: string;           // how the voiceover says the unit, e.g. "hours a year"
  topic: 'money' | 'work' | 'people' | 'food' | 'nature' | 'energy' | 'tech' | 'health' | 'places';
  grp?: string;           // related datasets share a group (used by /followup)
  ref: SourceRef;
  sourceName: string;     // shown on screen: "Data: <sourceName>, <year>, <license>"
  license: string;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  additive?: boolean;     // values can be summed across countries (SCALE format)
  threshold?: { value: number; label: string };
  minCountries?: number;
  lowerIsNews?: boolean;  // the interesting end of the ranking is the bottom
}

const wb = (indicator: string): SourceRef => ({ kind: 'worldbank', indicator });
const owid = (...slugs: string[]): SourceRef => ({ kind: 'owid', slugs });
const POP = wb('SP.POP.TOTL');
const WB = 'World Bank WDI';
const WB_LIC = 'CC BY 4.0';
const OWID_LIC = 'CC BY 4.0';

export const CATALOG: CatalogEntry[] = [
  // ---------- money ----------
  { id: 'wb_gdp_pc_ppp', title: 'GDP per person, adjusted for prices', unit: 'international dollars per person', topic: 'money', grp: 'income', ref: wb('NY.GDP.PCAP.PP.KD'), sourceName: WB, license: WB_LIC, prefix: '$' },
  { id: 'wb_gdp_pc_usd', title: 'GDP per person in US dollars', unit: 'dollars per person', topic: 'money', grp: 'income', ref: wb('NY.GDP.PCAP.CD'), sourceName: WB, license: WB_LIC, prefix: '$' },
  { id: 'wb_gni_pc_atlas', title: 'Income per person (GNI, Atlas method)', unit: 'dollars per person', topic: 'money', grp: 'income', ref: wb('NY.GNP.PCAP.CD'), sourceName: WB, license: WB_LIC, prefix: '$' },
  { id: 'wb_100_dollars', title: 'What $100 buys, in US prices', unit: 'dollars of US-priced goods', topic: 'money', grp: 'prices', ref: { kind: 'reciprocal', of: wb('PA.NUS.PPPC.RF'), mult: 100 }, sourceName: WB, license: WB_LIC, prefix: '$' },
  { id: 'wb_price_level', title: 'Price level compared with the US', unit: 'percent of US prices', topic: 'money', grp: 'prices', ref: { kind: 'scale', of: wb('PA.NUS.PPPC.RF'), mult: 100 }, sourceName: WB, license: WB_LIC, suffix: '%' },
  { id: 'wb_inflation', title: 'Inflation, consumer prices', unit: 'percent a year', topic: 'money', grp: 'prices', ref: wb('FP.CPI.TOTL.ZG'), sourceName: WB, license: WB_LIC, decimals: 1, suffix: '%' },
  { id: 'wb_hh_consumption_pc', title: 'Household spending per person', unit: 'dollars a year', topic: 'money', grp: 'income', ref: wb('NE.CON.PRVT.PC.KD'), sourceName: WB, license: WB_LIC, prefix: '$' },
  { id: 'wb_remittances_gdp', title: 'Money sent home by workers abroad', unit: 'percent of GDP', topic: 'money', grp: 'trade', ref: wb('BX.TRF.PWKR.DT.GD.ZS'), sourceName: WB, license: WB_LIC, decimals: 1, suffix: '%' },
  { id: 'wb_tax_revenue', title: 'Tax revenue', unit: 'percent of GDP', topic: 'money', grp: 'government', ref: wb('GC.TAX.TOTL.GD.ZS'), sourceName: WB, license: WB_LIC, decimals: 1, suffix: '%', minCountries: 80 },
  { id: 'wb_exports_gdp', title: 'Exports', unit: 'percent of GDP', topic: 'money', grp: 'trade', ref: wb('NE.EXP.GNFS.ZS'), sourceName: WB, license: WB_LIC, decimals: 0, suffix: '%' },
  { id: 'wb_imports_gdp', title: 'Imports', unit: 'percent of GDP', topic: 'money', grp: 'trade', ref: wb('NE.IMP.GNFS.ZS'), sourceName: WB, license: WB_LIC, decimals: 0, suffix: '%' },
  { id: 'wb_tourist_arrivals', title: 'International tourist arrivals', unit: 'arrivals a year', topic: 'places', grp: 'tourism', ref: wb('ST.INT.ARVL'), sourceName: WB, license: WB_LIC, additive: true },
  { id: 'wb_tourists_per_resident', title: 'Tourists per resident', unit: 'tourist arrivals per resident', topic: 'places', grp: 'tourism', ref: { kind: 'ratio', num: wb('ST.INT.ARVL'), den: POP }, sourceName: WB, license: WB_LIC, decimals: 1, threshold: { value: 1, label: 'more tourists than residents' } },
  { id: 'wb_tourism_receipts', title: 'Money earned from tourism', unit: 'dollars a year', topic: 'money', grp: 'tourism', ref: wb('ST.INT.RCPT.CD'), sourceName: WB, license: WB_LIC, prefix: '$', additive: true },
  { id: 'wb_military_gdp', title: 'Military spending', unit: 'percent of GDP', topic: 'money', grp: 'military', ref: wb('MS.MIL.XPND.GD.ZS'), sourceName: 'World Bank WDI / SIPRI', license: WB_LIC, decimals: 1, suffix: '%' },
  { id: 'wb_military_usd', title: 'Military spending', unit: 'dollars a year', topic: 'money', grp: 'military', ref: wb('MS.MIL.XPND.CD'), sourceName: 'World Bank WDI / SIPRI', license: WB_LIC, prefix: '$', additive: true },
  { id: 'wb_military_pc', title: 'Military spending per person', unit: 'dollars per person', topic: 'money', grp: 'military', ref: { kind: 'ratio', num: wb('MS.MIL.XPND.CD'), den: POP }, sourceName: 'World Bank WDI / SIPRI', license: WB_LIC, prefix: '$' },
  { id: 'wb_savings_gdp', title: 'Gross domestic savings', unit: 'percent of GDP', topic: 'money', grp: 'income', ref: wb('NY.GDS.TOTL.ZS'), sourceName: WB, license: WB_LIC, suffix: '%' },
  { id: 'wb_gov_debt', title: 'Central government debt', unit: 'percent of GDP', topic: 'money', grp: 'government', ref: wb('GC.DOD.TOTL.GD.ZS'), sourceName: WB, license: WB_LIC, suffix: '%', minCountries: 60 },
  { id: 'wb_agri_gdp', title: 'Farming, forestry and fishing', unit: 'percent of GDP', topic: 'work', grp: 'economy', ref: wb('NV.AGR.TOTL.ZS'), sourceName: WB, license: WB_LIC, decimals: 1, suffix: '%' },
  { id: 'wb_manufacturing_gdp', title: 'Manufacturing', unit: 'percent of GDP', topic: 'work', grp: 'economy', ref: wb('NV.IND.MANF.ZS'), sourceName: WB, license: WB_LIC, decimals: 1, suffix: '%' },
  { id: 'wb_fdi_gdp', title: 'Foreign investment flowing in', unit: 'percent of GDP', topic: 'money', grp: 'trade', ref: wb('BX.KLT.DINV.WD.GD.ZS'), sourceName: WB, license: WB_LIC, decimals: 1, suffix: '%' },
  { id: 'wb_gdp_usd', title: 'Size of the economy (GDP)', unit: 'dollars', topic: 'money', grp: 'income', ref: wb('NY.GDP.MKTP.CD'), sourceName: WB, license: WB_LIC, prefix: '$', additive: true },
  { id: 'wb_gdp_ppp', title: 'Size of the economy, adjusted for prices', unit: 'international dollars', topic: 'money', grp: 'income', ref: wb('NY.GDP.MKTP.PP.KD'), sourceName: WB, license: WB_LIC, prefix: '$', additive: true },
  { id: 'wb_lending_rate', title: 'Bank lending interest rate', unit: 'percent', topic: 'money', grp: 'prices', ref: wb('FR.INR.LEND'), sourceName: WB, license: WB_LIC, decimals: 1, suffix: '%', minCountries: 60 },
  { id: 'wb_hightech_exports', title: 'High-tech exports', unit: 'percent of manufactured exports', topic: 'tech', grp: 'trade', ref: wb('TX.VAL.TECH.MF.ZS'), sourceName: WB, license: WB_LIC, suffix: '%', minCountries: 80 },
  { id: 'wb_rnd_gdp', title: 'Research and development spending', unit: 'percent of GDP', topic: 'tech', grp: 'science', ref: wb('GB.XPD.RSDV.GD.ZS'), sourceName: WB, license: WB_LIC, decimals: 2, suffix: '%', minCountries: 60 },
  { id: 'wb_health_spend_pc', title: 'Health spending per person', unit: 'dollars a year', topic: 'health', grp: 'health_system', ref: wb('SH.XPD.CHEX.PC.CD'), sourceName: 'World Bank WDI / WHO', license: WB_LIC, prefix: '$' },
  { id: 'wb_education_spend', title: 'Government spending on education', unit: 'percent of GDP', topic: 'people', grp: 'education', ref: wb('SE.XPD.TOTL.GD.ZS'), sourceName: WB, license: WB_LIC, decimals: 1, suffix: '%', minCountries: 80 },
  { id: 'wb_market_cap', title: 'Stock market value', unit: 'percent of GDP', topic: 'money', grp: 'income', ref: wb('CM.MKT.LCAP.GD.ZS'), sourceName: WB, license: WB_LIC, suffix: '%', minCountries: 40 },
  { id: 'wb_gini', title: 'Income inequality (Gini index)', unit: 'Gini points', topic: 'money', grp: 'income', ref: wb('SI.POV.GINI'), sourceName: WB, license: WB_LIC, decimals: 1, minCountries: 40 },
  { id: 'owid_extreme_poverty', title: 'Share living on under $3 a day', unit: 'percent of people', topic: 'money', grp: 'income', ref: owid('share-of-population-in-extreme-poverty'), sourceName: 'Our World in Data / World Bank PIP', license: OWID_LIC, decimals: 1, suffix: '%', minCountries: 60 },
  { id: 'owid_median_income', title: 'Median income per day', unit: 'dollars a day', topic: 'money', grp: 'income', ref: owid('daily-median-income'), sourceName: 'Our World in Data / World Bank PIP', license: OWID_LIC, decimals: 2, prefix: '$', minCountries: 60 },
  { id: 'owid_gdp_pc_maddison', title: 'GDP per person over 200 years', unit: 'international dollars', topic: 'money', grp: 'income', ref: owid('gdp-per-capita-maddison'), sourceName: 'Our World in Data / Maddison Project', license: OWID_LIC, prefix: '$', minCountries: 100 },
  { id: 'owid_productivity', title: 'Output per hour worked', unit: 'international dollars per hour', topic: 'work', grp: 'work_hours', ref: owid('labor-productivity-per-hour-pennworldtable'), sourceName: 'Our World in Data / Penn World Table', license: OWID_LIC, prefix: '$', minCountries: 50 },

  // ---------- work ----------
  { id: 'owid_working_hours', title: 'Annual working hours per worker', unit: 'hours a year', topic: 'work', grp: 'work_hours', ref: owid('annual-working-hours-per-worker'), sourceName: 'Our World in Data / Penn World Table', license: OWID_LIC, suffix: ' hours', minCountries: 60 },
  { id: 'wb_unemployment', title: 'Unemployment rate', unit: 'percent of the workforce', topic: 'work', grp: 'jobs', ref: wb('SL.UEM.TOTL.ZS'), sourceName: 'World Bank WDI / ILO', license: WB_LIC, decimals: 1, suffix: '%' },
  { id: 'wb_youth_unemployment', title: 'Youth unemployment (ages 15–24)', unit: 'percent', topic: 'work', grp: 'jobs', ref: wb('SL.UEM.1524.ZS'), sourceName: 'World Bank WDI / ILO', license: WB_LIC, decimals: 1, suffix: '%' },
  { id: 'wb_female_labor', title: 'Women in the workforce', unit: 'percent of women 15+', topic: 'work', grp: 'jobs', ref: wb('SL.TLF.CACT.FE.ZS'), sourceName: 'World Bank WDI / ILO', license: WB_LIC, decimals: 0, suffix: '%' },
  { id: 'wb_agri_jobs', title: 'Jobs in farming', unit: 'percent of all jobs', topic: 'work', grp: 'economy', ref: wb('SL.AGR.EMPL.ZS'), sourceName: 'World Bank WDI / ILO', license: WB_LIC, decimals: 0, suffix: '%' },
  { id: 'wb_service_jobs', title: 'Jobs in services', unit: 'percent of all jobs', topic: 'work', grp: 'economy', ref: wb('SL.SRV.EMPL.ZS'), sourceName: 'World Bank WDI / ILO', license: WB_LIC, decimals: 0, suffix: '%' },
  { id: 'wb_industry_jobs', title: 'Jobs in industry', unit: 'percent of all jobs', topic: 'work', grp: 'economy', ref: wb('SL.IND.EMPL.ZS'), sourceName: 'World Bank WDI / ILO', license: WB_LIC, decimals: 0, suffix: '%' },
  { id: 'wb_self_employed', title: 'Self-employed workers', unit: 'percent of workers', topic: 'work', grp: 'jobs', ref: wb('SL.EMP.SELF.ZS'), sourceName: 'World Bank WDI / ILO', license: WB_LIC, decimals: 0, suffix: '%' },
  { id: 'wb_labor_force_total', title: 'Size of the workforce', unit: 'workers', topic: 'work', grp: 'jobs', ref: wb('SL.TLF.TOTL.IN'), sourceName: 'World Bank WDI / ILO', license: WB_LIC, additive: true },
  { id: 'wb_women_parliament', title: 'Seats held by women in parliament', unit: 'percent of seats', topic: 'people', grp: 'society', ref: wb('SG.GEN.PARL.ZS'), sourceName: 'World Bank WDI / IPU', license: WB_LIC, decimals: 0, suffix: '%' },

  // ---------- people ----------
  { id: 'wb_population', title: 'Population', unit: 'people', topic: 'people', grp: 'population', ref: POP, sourceName: WB, license: WB_LIC, additive: true },
  { id: 'wb_life_expectancy', title: 'Life expectancy at birth', unit: 'years', topic: 'health', grp: 'lifespan', ref: wb('SP.DYN.LE00.IN'), sourceName: 'World Bank WDI / UN', license: WB_LIC, decimals: 1, suffix: ' years' },
  { id: 'owid_life_expectancy', title: 'Life expectancy over 200 years', unit: 'years', topic: 'health', grp: 'lifespan', ref: owid('life-expectancy'), sourceName: 'Our World in Data / Riley, UN WPP', license: OWID_LIC, decimals: 1, suffix: ' years' },
  { id: 'wb_life_exp_female', title: 'Life expectancy of women', unit: 'years', topic: 'health', grp: 'lifespan', ref: wb('SP.DYN.LE00.FE.IN'), sourceName: 'World Bank WDI / UN', license: WB_LIC, decimals: 1, suffix: ' years' },
  { id: 'wb_life_exp_male', title: 'Life expectancy of men', unit: 'years', topic: 'health', grp: 'lifespan', ref: wb('SP.DYN.LE00.MA.IN'), sourceName: 'World Bank WDI / UN', license: WB_LIC, decimals: 1, suffix: ' years' },
  { id: 'wb_fertility', title: 'Children per woman', unit: 'children per woman', topic: 'people', grp: 'births', ref: wb('SP.DYN.TFRT.IN'), sourceName: 'World Bank WDI / UN', license: WB_LIC, decimals: 2 },
  { id: 'wb_birth_rate', title: 'Births per 1,000 people', unit: 'births per 1,000 people a year', topic: 'people', grp: 'births', ref: wb('SP.DYN.CBRT.IN'), sourceName: 'World Bank WDI / UN', license: WB_LIC, decimals: 1 },
  { id: 'wb_age_65', title: 'People aged 65 and over', unit: 'percent of the population', topic: 'people', grp: 'age', ref: wb('SP.POP.65UP.TO.ZS'), sourceName: 'World Bank WDI / UN', license: WB_LIC, decimals: 1, suffix: '%' },
  { id: 'wb_age_0_14', title: 'Children under 15', unit: 'percent of the population', topic: 'people', grp: 'age', ref: wb('SP.POP.0014.TO.ZS'), sourceName: 'World Bank WDI / UN', license: WB_LIC, decimals: 1, suffix: '%' },
  { id: 'owid_median_age', title: 'Median age', unit: 'years', topic: 'people', grp: 'age', ref: owid('median-age'), sourceName: 'Our World in Data / UN WPP', license: 'CC BY 3.0 IGO', decimals: 1, suffix: ' years' },
  { id: 'wb_urban', title: 'People living in cities', unit: 'percent of the population', topic: 'places', grp: 'cities', ref: wb('SP.URB.TOTL.IN.ZS'), sourceName: 'World Bank WDI / UN', license: WB_LIC, decimals: 0, suffix: '%' },
  { id: 'wb_density', title: 'People per square kilometre', unit: 'people per square kilometre', topic: 'places', grp: 'population', ref: wb('EN.POP.DNST'), sourceName: WB, license: WB_LIC },
  { id: 'wb_largest_city_share', title: 'Share living in the largest city', unit: 'percent of city dwellers', topic: 'places', grp: 'cities', ref: wb('EN.URB.LCTY.UR.ZS'), sourceName: 'World Bank WDI / UN', license: WB_LIC, suffix: '%' },
  { id: 'wb_migrants', title: 'People born in another country', unit: 'percent of the population', topic: 'people', grp: 'migration', ref: wb('SM.POP.TOTL.ZS'), sourceName: 'World Bank WDI / UN', license: WB_LIC, decimals: 1, suffix: '%' },
  { id: 'wb_female_pop', title: 'Women in the population', unit: 'percent of the population', topic: 'people', grp: 'population', ref: wb('SP.POP.TOTL.FE.ZS'), sourceName: 'World Bank WDI / UN', license: WB_LIC, decimals: 1, suffix: '%', lowerIsNews: true },
  { id: 'wb_pop_growth', title: 'Population growth', unit: 'percent a year', topic: 'people', grp: 'population', ref: wb('SP.POP.GROW'), sourceName: WB, license: WB_LIC, decimals: 1, suffix: '%' },
  { id: 'wb_tertiary', title: 'College and university enrolment', unit: 'percent of the college-age population', topic: 'people', grp: 'education', ref: wb('SE.TER.ENRR'), sourceName: 'World Bank WDI / UNESCO', license: WB_LIC, suffix: '%', minCountries: 80 },
  { id: 'wb_literacy', title: 'Adults who can read and write', unit: 'percent of adults', topic: 'people', grp: 'education', ref: wb('SE.ADT.LITR.ZS'), sourceName: 'World Bank WDI / UNESCO', license: WB_LIC, suffix: '%', minCountries: 30, lowerIsNews: true },
  { id: 'owid_schooling_years', title: 'Average years of schooling', unit: 'years', topic: 'people', grp: 'education', ref: owid('mean-years-of-schooling-long-run', 'mean-years-of-schooling'), sourceName: 'Our World in Data / UNDP', license: OWID_LIC, decimals: 1, suffix: ' years' },
  { id: 'owid_height_men', title: 'Average height of men', unit: 'centimetres', topic: 'people', grp: 'height', ref: owid('average-height-of-men'), sourceName: 'Our World in Data / NCD-RisC', license: OWID_LIC, decimals: 1, suffix: ' cm' },
  { id: 'owid_height_women', title: 'Average height of women', unit: 'centimetres', topic: 'people', grp: 'height', ref: owid('average-height-of-women'), sourceName: 'Our World in Data / NCD-RisC', license: OWID_LIC, decimals: 1, suffix: ' cm' },
  { id: 'owid_hdi', title: 'Human Development Index', unit: 'index points (0 to 1)', topic: 'people', grp: 'society', ref: owid('human-development-index'), sourceName: 'Our World in Data / UNDP', license: 'CC BY 3.0 IGO', decimals: 3 },
  { id: 'owid_population_long', title: 'Population over the centuries', unit: 'people', topic: 'people', grp: 'population', ref: owid('population'), sourceName: 'Our World in Data / UN WPP, HYDE, Gapminder', license: OWID_LIC, additive: true },

  // ---------- health ----------
  { id: 'wb_infant_mortality', title: 'Infant deaths per 1,000 births', unit: 'deaths per 1,000 live births', topic: 'health', grp: 'child_health', ref: wb('SP.DYN.IMRT.IN'), sourceName: 'World Bank WDI / UN IGME', license: WB_LIC, decimals: 1, lowerIsNews: true },
  { id: 'wb_child_mortality', title: 'Child deaths before age five', unit: 'deaths per 1,000 live births', topic: 'health', grp: 'child_health', ref: wb('SH.DYN.MORT'), sourceName: 'World Bank WDI / UN IGME', license: WB_LIC, decimals: 1, lowerIsNews: true },
  { id: 'wb_doctors', title: 'Doctors per 1,000 people', unit: 'doctors per 1,000 people', topic: 'health', grp: 'health_system', ref: wb('SH.MED.PHYS.ZS'), sourceName: 'World Bank WDI / WHO', license: WB_LIC, decimals: 1, minCountries: 80 },
  { id: 'wb_hospital_beds', title: 'Hospital beds per 1,000 people', unit: 'beds per 1,000 people', topic: 'health', grp: 'health_system', ref: wb('SH.MED.BEDS.ZS'), sourceName: 'World Bank WDI / WHO', license: WB_LIC, decimals: 1, minCountries: 60 },
  { id: 'wb_alcohol', title: 'Alcohol consumed per adult', unit: 'litres of pure alcohol a year', topic: 'health', grp: 'habits', ref: wb('SH.ALC.PCAP.LI'), sourceName: 'World Bank WDI / WHO', license: WB_LIC, decimals: 1, suffix: ' litres' },
  { id: 'wb_smoking', title: 'Adults who smoke', unit: 'percent of adults', topic: 'health', grp: 'habits', ref: wb('SH.PRV.SMOK'), sourceName: 'World Bank WDI / WHO', license: WB_LIC, decimals: 1, suffix: '%' },
  { id: 'owid_obesity', title: 'Adults with obesity', unit: 'percent of adults', topic: 'health', grp: 'habits', ref: owid('share-of-adults-defined-as-obese'), sourceName: 'Our World in Data / WHO', license: OWID_LIC, decimals: 1, suffix: '%' },
  { id: 'owid_sugar', title: 'Sugar eaten per person', unit: 'kilograms a year', topic: 'food', grp: 'diet', ref: owid('sugar-consumption-per-person', 'per-capita-sugar-consumption'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, decimals: 1, suffix: ' kg' },

  // ---------- food ----------
  { id: 'owid_meat', title: 'Meat eaten per person', unit: 'kilograms a year', topic: 'food', grp: 'diet', ref: owid('meat-supply-per-person'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, decimals: 1, suffix: ' kg' },
  { id: 'owid_calories', title: 'Calories available per person', unit: 'calories a day', topic: 'food', grp: 'diet', ref: owid('daily-per-capita-caloric-supply'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, suffix: ' calories' },
  { id: 'owid_protein', title: 'Protein available per person', unit: 'grams a day', topic: 'food', grp: 'diet', ref: owid('daily-per-capita-protein-supply'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, decimals: 0, suffix: ' g' },
  { id: 'owid_fish', title: 'Fish and seafood eaten per person', unit: 'kilograms a year', topic: 'food', grp: 'diet', ref: owid('fish-and-seafood-consumption-per-capita'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, decimals: 1, suffix: ' kg' },
  { id: 'owid_milk', title: 'Milk consumed per person', unit: 'kilograms a year', topic: 'food', grp: 'diet', ref: owid('per-capita-milk-consumption'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, decimals: 0, suffix: ' kg' },
  { id: 'owid_eggs', title: 'Eggs eaten per person', unit: 'kilograms a year', topic: 'food', grp: 'diet', ref: owid('per-capita-egg-consumption-kilograms-per-year'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, decimals: 1, suffix: ' kg' },
  { id: 'owid_fruit', title: 'Fruit eaten per person', unit: 'kilograms a year', topic: 'food', grp: 'diet', ref: owid('fruit-consumption-per-capita'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, decimals: 0, suffix: ' kg' },
  { id: 'owid_vegetables', title: 'Vegetables eaten per person', unit: 'kilograms a year', topic: 'food', grp: 'diet', ref: owid('vegetable-consumption-per-capita'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, decimals: 0, suffix: ' kg' },
  { id: 'owid_poultry_pc', title: 'Chicken eaten per person', unit: 'kilograms a year', topic: 'food', grp: 'diet', ref: owid('per-capita-poultry-consumption', 'poultry-meat-consumption-per-capita'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, decimals: 1, suffix: ' kg' },
  { id: 'owid_beef_pc', title: 'Beef eaten per person', unit: 'kilograms a year', topic: 'food', grp: 'diet', ref: owid('per-capita-beef-and-buffalo-meat-consumption', 'beef-and-buffalo-meat-consumption-per-person'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, decimals: 1, suffix: ' kg' },
  { id: 'owid_pork_pc', title: 'Pork eaten per person', unit: 'kilograms a year', topic: 'food', grp: 'diet', ref: owid('per-capita-pig-meat-consumption', 'pigmeat-consumption-per-person'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, decimals: 1, suffix: ' kg' },
  { id: 'owid_food_waste', title: 'Food wasted per person', unit: 'kilograms a year', topic: 'food', grp: 'diet', ref: owid('food-waste-per-capita'), sourceName: 'Our World in Data / UNEP', license: OWID_LIC, decimals: 0, suffix: ' kg', minCountries: 80 },
  { id: 'wb_cereal_yield', title: 'Cereal harvest per hectare', unit: 'kilograms per hectare', topic: 'food', grp: 'farming', ref: wb('AG.YLD.CREL.KG'), sourceName: 'World Bank WDI / FAO', license: WB_LIC, suffix: ' kg' },
  { id: 'wb_cereal_production', title: 'Cereal production', unit: 'tonnes a year', topic: 'food', grp: 'farming', ref: wb('AG.PRD.CREL.MT'), sourceName: 'World Bank WDI / FAO', license: WB_LIC, additive: true },
  { id: 'owid_cocoa', title: 'Cocoa bean production', unit: 'tonnes a year', topic: 'food', grp: 'crops', ref: owid('cocoa-bean-production'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, additive: true, minCountries: 30 },
  { id: 'owid_coffee', title: 'Coffee bean production', unit: 'tonnes a year', topic: 'food', grp: 'crops', ref: owid('coffee-bean-production', 'coffee-production'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, additive: true, minCountries: 30 },
  { id: 'owid_banana', title: 'Banana production', unit: 'tonnes a year', topic: 'food', grp: 'crops', ref: owid('banana-production'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, additive: true, minCountries: 60 },
  { id: 'owid_rice', title: 'Rice production', unit: 'tonnes a year', topic: 'food', grp: 'crops', ref: owid('rice-production'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, additive: true, minCountries: 60 },
  { id: 'owid_wheat', title: 'Wheat production', unit: 'tonnes a year', topic: 'food', grp: 'crops', ref: owid('wheat-production'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, additive: true, minCountries: 60 },
  { id: 'owid_potato', title: 'Potato production', unit: 'tonnes a year', topic: 'food', grp: 'crops', ref: owid('potato-production'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, additive: true, minCountries: 60 },
  { id: 'owid_avocado', title: 'Avocado production', unit: 'tonnes a year', topic: 'food', grp: 'crops', ref: owid('avocado-production'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, additive: true, minCountries: 30 },
  { id: 'owid_tea', title: 'Tea production', unit: 'tonnes a year', topic: 'food', grp: 'crops', ref: owid('tea-production'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, additive: true, minCountries: 25 },
  { id: 'owid_wine', title: 'Wine production', unit: 'tonnes a year', topic: 'food', grp: 'crops', ref: owid('wine-production'), sourceName: 'Our World in Data / FAO', license: OWID_LIC, additive: true, minCountries: 30 },
  { id: 'owid_cattle_pc', title: 'Cattle per person', unit: 'cattle per person', topic: 'nature', grp: 'livestock', ref: { kind: 'ratio', num: owid('cattle-livestock-count-heads'), den: POP }, sourceName: 'FAO via Our World in Data; World Bank', license: OWID_LIC, decimals: 2, threshold: { value: 1, label: 'more cattle than people' } },
  { id: 'owid_pigs_pc', title: 'Pigs per person', unit: 'pigs per person', topic: 'nature', grp: 'livestock', ref: { kind: 'ratio', num: owid('pig-livestock-count-heads'), den: POP }, sourceName: 'FAO via Our World in Data; World Bank', license: OWID_LIC, decimals: 2, threshold: { value: 1, label: 'more pigs than people' } },
  { id: 'owid_chickens_pc', title: 'Chickens per person', unit: 'chickens per person', topic: 'nature', grp: 'livestock', ref: { kind: 'ratio', num: owid('poultry-livestock-count'), den: POP }, sourceName: 'FAO via Our World in Data; World Bank', license: OWID_LIC, decimals: 1 },

  // ---------- nature and land ----------
  { id: 'wb_forest_share', title: 'Land covered by forest', unit: 'percent of land', topic: 'nature', grp: 'land', ref: wb('AG.LND.FRST.ZS'), sourceName: 'World Bank WDI / FAO', license: WB_LIC, decimals: 0, suffix: '%' },
  { id: 'wb_forest_area', title: 'Forest area', unit: 'square kilometres', topic: 'nature', grp: 'land', ref: wb('AG.LND.FRST.K2'), sourceName: 'World Bank WDI / FAO', license: WB_LIC, additive: true },
  { id: 'wb_forest_pc', title: 'Forest per person', unit: 'square metres per person', topic: 'nature', grp: 'land', ref: { kind: 'ratio', num: wb('AG.LND.FRST.K2'), den: POP, mult: 1_000_000 }, sourceName: 'World Bank WDI / FAO', license: WB_LIC },
  { id: 'wb_farmland_share', title: 'Land used for farming', unit: 'percent of land', topic: 'nature', grp: 'land', ref: wb('AG.LND.AGRI.ZS'), sourceName: 'World Bank WDI / FAO', license: WB_LIC, decimals: 0, suffix: '%' },
  { id: 'wb_arable_pc', title: 'Cropland per person', unit: 'hectares per person', topic: 'nature', grp: 'land', ref: wb('AG.LND.ARBL.HA.PC'), sourceName: 'World Bank WDI / FAO', license: WB_LIC, decimals: 2 },
  { id: 'wb_area', title: 'Country size', unit: 'square kilometres', topic: 'places', grp: 'land', ref: wb('AG.SRF.TOTL.K2'), sourceName: WB, license: WB_LIC, additive: true },
  { id: 'wb_area_pc', title: 'Land per person', unit: 'square metres per person', topic: 'places', grp: 'land', ref: { kind: 'ratio', num: wb('AG.LND.TOTL.K2'), den: POP, mult: 1_000_000 }, sourceName: WB, license: WB_LIC },
  { id: 'wb_rainfall', title: 'Average rainfall', unit: 'millimetres a year', topic: 'nature', grp: 'climate', ref: wb('AG.LND.PRCP.MM'), sourceName: 'World Bank WDI / FAO', license: WB_LIC, suffix: ' mm' },
  { id: 'wb_freshwater_pc', title: 'Renewable fresh water per person', unit: 'cubic metres a year', topic: 'nature', grp: 'water', ref: wb('ER.H2O.INTR.PC'), sourceName: 'World Bank WDI / FAO', license: WB_LIC },
  { id: 'wb_protected_areas', title: 'Land and sea under protection', unit: 'percent of territory', topic: 'nature', grp: 'land', ref: wb('ER.PTD.TOTL.ZS'), sourceName: 'World Bank WDI / UNEP-WCMC', license: WB_LIC, decimals: 1, suffix: '%' },
  { id: 'wb_water_withdrawal', title: 'Fresh water used each year', unit: 'percent of renewable supply', topic: 'nature', grp: 'water', ref: wb('ER.H2O.FWST.ZS'), sourceName: 'World Bank WDI / FAO', license: WB_LIC, suffix: '%', minCountries: 80 },
  { id: 'owid_plastic_waste', title: 'Plastic waste per person', unit: 'kilograms a day', topic: 'nature', grp: 'waste', ref: owid('plastic-waste-per-capita'), sourceName: 'Our World in Data / Jambeck et al.', license: OWID_LIC, decimals: 2, suffix: ' kg', minCountries: 80 },
  { id: 'owid_mismanaged_plastic', title: 'Plastic waste that ends up in the ocean', unit: 'tonnes a year', topic: 'nature', grp: 'waste', ref: owid('plastic-waste-emitted-to-the-ocean', 'plastic-waste-emitted-to-the-ocean-per-capita'), sourceName: 'Our World in Data / Meijer et al.', license: OWID_LIC, additive: true, minCountries: 80 },
  { id: 'owid_temperature_change', title: 'Warming since the 1950s', unit: 'degrees Celsius', topic: 'nature', grp: 'climate', ref: owid('annual-temperature-anomalies'), sourceName: 'Our World in Data / Copernicus', license: OWID_LIC, decimals: 1, suffix: '°C', minCountries: 150 },

  // ---------- energy and emissions ----------
  { id: 'owid_co2_pc', title: 'CO₂ emissions per person', unit: 'tonnes a year', topic: 'energy', grp: 'emissions', ref: owid('co-emissions-per-capita'), sourceName: 'Our World in Data / Global Carbon Budget', license: OWID_LIC, decimals: 1, suffix: ' tonnes' },
  { id: 'owid_co2_total', title: 'CO₂ emissions', unit: 'tonnes a year', topic: 'energy', grp: 'emissions', ref: owid('annual-co2-emissions-per-country'), sourceName: 'Our World in Data / Global Carbon Budget', license: OWID_LIC, additive: true },
  { id: 'owid_co2_cumulative', title: 'All CO₂ ever emitted', unit: 'tonnes', topic: 'energy', grp: 'emissions', ref: owid('cumulative-co-emissions'), sourceName: 'Our World in Data / Global Carbon Budget', license: OWID_LIC, additive: true },
  { id: 'owid_ghg_pc', title: 'Greenhouse gas emissions per person', unit: 'tonnes of CO₂-equivalent a year', topic: 'energy', grp: 'emissions', ref: owid('per-capita-ghg-emissions'), sourceName: 'Our World in Data / Jones et al.', license: OWID_LIC, decimals: 1, suffix: ' tonnes' },
  { id: 'owid_energy_pc', title: 'Energy used per person', unit: 'kilowatt-hours a year', topic: 'energy', grp: 'energy_use', ref: owid('per-capita-energy-use'), sourceName: 'Our World in Data / Energy Institute, EIA', license: OWID_LIC, suffix: ' kWh' },
  { id: 'owid_electricity_pc', title: 'Electricity generated per person', unit: 'kilowatt-hours a year', topic: 'energy', grp: 'electricity', ref: owid('per-capita-electricity-generation'), sourceName: 'Our World in Data / Ember, Energy Institute', license: OWID_LIC, suffix: ' kWh' },
  { id: 'owid_renewables_elec', title: 'Electricity from renewables', unit: 'percent of electricity', topic: 'energy', grp: 'electricity', ref: owid('share-electricity-renewables'), sourceName: 'Our World in Data / Ember, Energy Institute', license: OWID_LIC, decimals: 0, suffix: '%' },
  { id: 'owid_solar_elec', title: 'Electricity from solar', unit: 'percent of electricity', topic: 'energy', grp: 'electricity', ref: owid('share-electricity-solar'), sourceName: 'Our World in Data / Ember, Energy Institute', license: OWID_LIC, decimals: 1, suffix: '%' },
  { id: 'owid_wind_elec', title: 'Electricity from wind', unit: 'percent of electricity', topic: 'energy', grp: 'electricity', ref: owid('share-electricity-wind'), sourceName: 'Our World in Data / Ember, Energy Institute', license: OWID_LIC, decimals: 1, suffix: '%' },
  { id: 'owid_nuclear_elec', title: 'Electricity from nuclear', unit: 'percent of electricity', topic: 'energy', grp: 'electricity', ref: owid('share-electricity-nuclear'), sourceName: 'Our World in Data / Ember, Energy Institute', license: OWID_LIC, decimals: 0, suffix: '%' },
  { id: 'owid_coal_elec', title: 'Electricity from coal', unit: 'percent of electricity', topic: 'energy', grp: 'electricity', ref: owid('share-electricity-coal'), sourceName: 'Our World in Data / Ember, Energy Institute', license: OWID_LIC, decimals: 0, suffix: '%' },
  { id: 'owid_hydro_elec', title: 'Electricity from hydropower', unit: 'percent of electricity', topic: 'energy', grp: 'electricity', ref: owid('share-electricity-hydro'), sourceName: 'Our World in Data / Ember, Energy Institute', license: OWID_LIC, decimals: 0, suffix: '%' },
  { id: 'owid_gas_elec', title: 'Electricity from gas', unit: 'percent of electricity', topic: 'energy', grp: 'electricity', ref: owid('share-electricity-gas'), sourceName: 'Our World in Data / Ember, Energy Institute', license: OWID_LIC, decimals: 0, suffix: '%' },
  { id: 'owid_low_carbon_energy', title: 'Energy from low-carbon sources', unit: 'percent of all energy', topic: 'energy', grp: 'energy_use', ref: owid('low-carbon-share-energy'), sourceName: 'Our World in Data / Energy Institute', license: OWID_LIC, decimals: 0, suffix: '%', minCountries: 60 },
  { id: 'wb_renewable_energy', title: 'Renewable energy use', unit: 'percent of final energy', topic: 'energy', grp: 'energy_use', ref: wb('EG.FEC.RNEW.ZS'), sourceName: 'World Bank WDI / IEA, IRENA', license: WB_LIC, decimals: 0, suffix: '%' },
  { id: 'wb_electricity_access', title: 'People with electricity', unit: 'percent of the population', topic: 'energy', grp: 'electricity', ref: wb('EG.ELC.ACCS.ZS'), sourceName: 'World Bank WDI', license: WB_LIC, decimals: 0, suffix: '%', lowerIsNews: true },
  { id: 'wb_clean_cooking', title: 'People cooking with clean fuels', unit: 'percent of the population', topic: 'energy', grp: 'energy_use', ref: wb('EG.CFT.ACCS.ZS'), sourceName: 'World Bank WDI / WHO', license: WB_LIC, decimals: 0, suffix: '%', lowerIsNews: true },
  { id: 'owid_oil_production', title: 'Oil production', unit: 'terawatt-hours a year', topic: 'energy', grp: 'fossil', ref: owid('oil-production-by-country'), sourceName: 'Our World in Data / Energy Institute', license: OWID_LIC, additive: true, minCountries: 40 },
  { id: 'owid_coal_production', title: 'Coal production', unit: 'terawatt-hours a year', topic: 'energy', grp: 'fossil', ref: owid('coal-production-by-country'), sourceName: 'Our World in Data / Energy Institute', license: OWID_LIC, additive: true, minCountries: 30 },
  { id: 'owid_gas_production', title: 'Natural gas production', unit: 'terawatt-hours a year', topic: 'energy', grp: 'fossil', ref: owid('gas-production-by-country'), sourceName: 'Our World in Data / Energy Institute', license: OWID_LIC, additive: true, minCountries: 40 },

  // ---------- tech and transport ----------
  { id: 'wb_internet', title: 'People using the internet', unit: 'percent of the population', topic: 'tech', grp: 'internet', ref: wb('IT.NET.USER.ZS'), sourceName: 'World Bank WDI / ITU', license: WB_LIC, decimals: 0, suffix: '%' },
  { id: 'owid_internet', title: 'People using the internet since 1990', unit: 'percent of the population', topic: 'tech', grp: 'internet', ref: owid('share-of-individuals-using-the-internet'), sourceName: 'Our World in Data / ITU', license: OWID_LIC, decimals: 0, suffix: '%' },
  { id: 'wb_mobile_subs', title: 'Mobile phone subscriptions per 100 people', unit: 'subscriptions per 100 people', topic: 'tech', grp: 'internet', ref: wb('IT.CEL.SETS.P2'), sourceName: 'World Bank WDI / ITU', license: WB_LIC },
  { id: 'wb_broadband', title: 'Home broadband subscriptions per 100 people', unit: 'subscriptions per 100 people', topic: 'tech', grp: 'internet', ref: wb('IT.NET.BBND.P2'), sourceName: 'World Bank WDI / ITU', license: WB_LIC, decimals: 1 },
  { id: 'wb_patents', title: 'Patent applications by residents', unit: 'applications a year', topic: 'tech', grp: 'science', ref: wb('IP.PAT.RESD'), sourceName: 'World Bank WDI / WIPO', license: WB_LIC, additive: true, minCountries: 60 },
  { id: 'wb_patents_pc', title: 'Patent applications per million people', unit: 'applications per million people', topic: 'tech', grp: 'science', ref: { kind: 'ratio', num: wb('IP.PAT.RESD'), den: POP, mult: 1_000_000 }, sourceName: 'World Bank WDI / WIPO', license: WB_LIC, minCountries: 60 },
  { id: 'wb_science_articles', title: 'Scientific articles published', unit: 'articles a year', topic: 'tech', grp: 'science', ref: wb('IP.JRN.ARTC.SC'), sourceName: 'World Bank WDI / NSF', license: WB_LIC, additive: true },
  { id: 'wb_science_articles_pc', title: 'Scientific articles per million people', unit: 'articles per million people', topic: 'tech', grp: 'science', ref: { kind: 'ratio', num: wb('IP.JRN.ARTC.SC'), den: POP, mult: 1_000_000 }, sourceName: 'World Bank WDI / NSF', license: WB_LIC },
  { id: 'wb_air_passengers', title: 'Air passengers carried', unit: 'passengers a year', topic: 'places', grp: 'transport', ref: wb('IS.AIR.PSGR'), sourceName: 'World Bank WDI / ICAO', license: WB_LIC, additive: true, minCountries: 80 },
  { id: 'wb_air_passengers_pc', title: 'Air trips per person', unit: 'passengers carried per resident', topic: 'places', grp: 'transport', ref: { kind: 'ratio', num: wb('IS.AIR.PSGR'), den: POP }, sourceName: 'World Bank WDI / ICAO', license: WB_LIC, decimals: 1, minCountries: 80 },
  { id: 'wb_rail_lines', title: 'Railway length', unit: 'kilometres of track', topic: 'places', grp: 'transport', ref: wb('IS.RRS.TOTL.KM'), sourceName: 'World Bank WDI', license: WB_LIC, additive: true, minCountries: 40 },
  { id: 'wb_container_traffic', title: 'Shipping containers handled in ports', unit: 'containers (TEU) a year', topic: 'places', grp: 'transport', ref: wb('IS.SHP.GOOD.TU'), sourceName: 'World Bank WDI / UNCTAD', license: WB_LIC, additive: true, minCountries: 60 },
  { id: 'owid_ev_share', title: 'New cars that are electric', unit: 'percent of new car sales', topic: 'tech', grp: 'transport', ref: owid('electric-car-sales-share'), sourceName: 'Our World in Data / IEA', license: OWID_LIC, decimals: 0, suffix: '%', minCountries: 25 },
  { id: 'owid_ai_investment', title: 'Private investment in AI', unit: 'dollars a year', topic: 'tech', grp: 'science', ref: owid('private-investment-in-artificial-intelligence'), sourceName: 'Our World in Data / Quid via AI Index', license: OWID_LIC, prefix: '$', additive: true, minCountries: 20 },
  { id: 'owid_space_objects', title: 'Objects launched into space', unit: 'objects a year', topic: 'tech', grp: 'space', ref: owid('yearly-number-of-objects-launched-into-outer-space'), sourceName: 'Our World in Data / UNOOSA', license: OWID_LIC, additive: true, minCountries: 20 },
  { id: 'owid_nobel', title: 'Nobel laureates per 10 million people', unit: 'laureates per 10 million people', topic: 'people', grp: 'science', ref: owid('nobel-prize-laureates-per-10-million-population', 'nobel-laureates-per-capita'), sourceName: 'Our World in Data / Nobel Foundation', license: OWID_LIC, decimals: 1, minCountries: 30 },

  // ---------- places and society ----------
  { id: 'wb_bank_account', title: 'Adults with a bank account', unit: 'percent of adults', topic: 'money', grp: 'income', ref: wb('FX.OWN.TOTL.ZS'), sourceName: 'World Bank Global Findex', license: WB_LIC, decimals: 0, suffix: '%', minCountries: 100 },
  { id: 'wb_safe_water', title: 'People with safely managed drinking water', unit: 'percent of the population', topic: 'health', grp: 'water', ref: wb('SH.H2O.SMDW.ZS'), sourceName: 'World Bank WDI / WHO, UNICEF', license: WB_LIC, decimals: 0, suffix: '%', minCountries: 100, lowerIsNews: true },
  { id: 'owid_tourism_trips', title: 'Trips abroad per person', unit: 'departures per resident', topic: 'places', grp: 'tourism', ref: { kind: 'ratio', num: wb('ST.INT.DPRT'), den: POP }, sourceName: WB, license: WB_LIC, decimals: 1, minCountries: 60 },
  { id: 'owid_land_area_share_mountain', title: 'Land above 1,000 metres', unit: 'percent of land', topic: 'places', grp: 'land', ref: owid('share-of-land-area-above-1000-meters'), sourceName: 'Our World in Data', license: OWID_LIC, decimals: 0, suffix: '%', minCountries: 100 },
  { id: 'owid_islands', title: 'Coastline length', unit: 'kilometres', topic: 'places', grp: 'land', ref: owid('coastline-length'), sourceName: 'Our World in Data / CIA World Factbook', license: OWID_LIC, additive: true, minCountries: 100 },
];
