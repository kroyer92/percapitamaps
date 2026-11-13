// Themes for the weekly long-form video: one subject, 8 to 10 maps. A themed video is easier to
// find through search than a mixed list, which is how a new channel's long-form gets its views.
// Datasets are listed best first; the planner skips any that is disabled, has no clear #1, or
// counts the "bad" end as #1 (the Gini index), and takes at most two from the same group.
export interface Theme {
  key: string;
  name: string; // shown on the thumbnail and the intro card, e.g. "MONEY"
  titles: string[]; // YouTube title options, no country named (the answers stay a surprise)
  quiz: string[]; // the same for the game-style video, written for 10 rounds
  intro: string; // the first thing the voice says
  question: string; // pinned comment
  tags: string[];
  datasets: string[];
}

export const THEMES: Theme[] = [
  {
    key: 'money', name: 'Money',
    titles: ['Where Your Money Goes Furthest: 10 Maps of the World’s Money', '10 Maps That Show Who Is Really Rich', 'The World’s Money in 10 Maps'],
    quiz: ['Can You Guess the World’s Richest Countries? 10-Round Map Quiz', 'Money Map Quiz: 10 Rounds Against the Clock', 'Guess the Country: 10 Maps of the World’s Money'],
    intro: 'Ten maps of money. Who earns the most, where prices are lowest, and where your money goes furthest.',
    question: 'Which of these 10 maps surprised you most?',
    tags: ['world maps', 'money', 'richest countries', 'cost of living by country', 'gdp per capita', 'data visualization', 'geography'],
    datasets: ['wb_100_dollars', 'wb_gdp_pc_ppp', 'owid_median_income', 'wb_price_level', 'wb_hh_consumption_pc', 'wb_tax_revenue', 'wb_health_spend_pc', 'wb_military_pc', 'wb_savings_gdp', 'wb_remittances_gdp', 'wb_inflation', 'wb_tourism_receipts'],
  },
  {
    key: 'health', name: 'Health',
    titles: ['Who Lives Longest? 10 Maps of the World’s Health', '10 Maps That Show How Healthy the World Really Is', 'The World’s Health in 10 Maps'],
    quiz: ['Can You Guess Who Lives Longest? 10-Round Map Quiz', 'Health Map Quiz: 10 Rounds Against the Clock', 'Guess the Country: 10 Maps of the World’s Health'],
    intro: 'Ten maps of health. Who lives longest, who smokes and drinks the most, and who has the most doctors.',
    question: 'Which of these 10 maps surprised you most?',
    tags: ['world maps', 'health', 'life expectancy by country', 'longest living countries', 'data visualization', 'geography'],
    datasets: ['wb_life_expectancy', 'wb_life_exp_female', 'wb_doctors', 'wb_hospital_beds', 'wb_health_spend_pc', 'owid_obesity', 'wb_alcohol', 'wb_smoking', 'wb_safe_water', 'wb_infant_mortality', 'wb_child_mortality'],
  },
  {
    key: 'food', name: 'Food',
    titles: ['What the World Eats: 10 Maps of Food', '10 Maps That Show Who Eats the Most', 'The World’s Diet in 10 Maps'],
    quiz: ['Can You Guess Who Eats the Most? 10-Round Map Quiz', 'Food Map Quiz: 10 Rounds Against the Clock', 'Guess the Country: 10 Maps of What the World Eats'],
    intro: 'Ten maps of food. Who eats the most meat, drinks the most coffee, and eats the most calories.',
    question: 'Which of these 10 maps surprised you most?',
    tags: ['world maps', 'food', 'meat consumption by country', 'coffee consumption', 'data visualization', 'geography'],
    datasets: ['owid_meat', 'owid_coffee', 'owid_calories', 'owid_milk', 'owid_eggs', 'owid_fish', 'owid_rice', 'owid_wine', 'owid_fruit', 'owid_vegetables', 'owid_cocoa', 'owid_potato', 'owid_poultry_pc', 'owid_beef_pc'],
  },
  {
    key: 'work', name: 'Work',
    titles: ['Who Works the Most? 10 Maps of the World’s Jobs', '10 Maps That Show How the World Works', 'The World’s Work in 10 Maps'],
    quiz: ['Can You Guess Who Works the Most? 10-Round Map Quiz', 'Work Map Quiz: 10 Rounds Against the Clock', 'Guess the Country: 10 Maps of How the World Works'],
    intro: 'Ten maps of work. Who works the longest hours, who gets the most done per hour, and where jobs are hardest to find.',
    question: 'Which of these 10 maps surprised you most?',
    tags: ['world maps', 'work', 'working hours by country', 'productivity', 'unemployment', 'data visualization', 'geography'],
    datasets: ['owid_working_hours', 'owid_productivity', 'wb_unemployment', 'wb_youth_unemployment', 'wb_female_labor', 'wb_self_employed', 'wb_agri_jobs', 'wb_service_jobs', 'wb_industry_jobs', 'wb_manufacturing_gdp', 'wb_agri_gdp'],
  },
  {
    key: 'people', name: 'People',
    titles: ['The World’s People in 10 Maps', '10 Maps That Show Who We Really Are', 'Tallest, Oldest, Most Educated: 10 Maps of People'],
    quiz: ['Can You Guess the Tallest and Oldest Countries? 10-Round Map Quiz', 'People Map Quiz: 10 Rounds Against the Clock', 'Guess the Country: 10 Maps of the World’s People'],
    intro: 'Ten maps of people. Who is tallest, who is oldest, and who stays in school the longest.',
    question: 'Which of these 10 maps surprised you most?',
    tags: ['world maps', 'population', 'tallest countries', 'median age by country', 'data visualization', 'geography'],
    datasets: ['owid_height_men', 'owid_height_women', 'owid_median_age', 'wb_fertility', 'owid_schooling_years', 'wb_age_65', 'wb_migrants', 'wb_tertiary', 'wb_women_parliament', 'wb_urban', 'wb_pop_growth', 'owid_hdi'],
  },
  {
    key: 'energy', name: 'Energy',
    titles: ['Who Uses the Most Energy? 10 Maps of Power and Pollution', '10 Maps That Show Where the World’s Energy Goes', 'The World’s Energy in 10 Maps'],
    quiz: ['Can You Guess Who Uses the Most Energy? 10-Round Map Quiz', 'Energy Map Quiz: 10 Rounds Against the Clock', 'Guess the Country: 10 Maps of Power and Pollution'],
    intro: 'Ten maps of energy. Who uses the most, who pollutes the most, and who runs on sun and wind.',
    question: 'Which of these 10 maps surprised you most?',
    tags: ['world maps', 'energy', 'co2 emissions per capita', 'renewable energy by country', 'data visualization', 'geography'],
    datasets: ['owid_energy_pc', 'owid_co2_pc', 'owid_electricity_pc', 'owid_renewables_elec', 'owid_solar_elec', 'owid_wind_elec', 'owid_nuclear_elec', 'owid_hydro_elec', 'owid_coal_elec', 'owid_ghg_pc', 'owid_low_carbon_energy'],
  },
  {
    key: 'tech', name: 'Tech',
    titles: ['Who Is Most Online? 10 Maps of the World’s Tech', '10 Maps That Show the World’s Tech Race', 'The World’s Technology in 10 Maps'],
    quiz: ['Can You Guess the Most Online Countries? 10-Round Map Quiz', 'Tech Map Quiz: 10 Rounds Against the Clock', 'Guess the Country: 10 Maps of the World’s Tech'],
    intro: 'Ten maps of technology. Who is most online, who invents the most, and who drives electric.',
    question: 'Which of these 10 maps surprised you most?',
    tags: ['world maps', 'technology', 'internet use by country', 'electric cars', 'patents', 'data visualization', 'geography'],
    datasets: ['wb_internet', 'wb_broadband', 'wb_mobile_subs', 'owid_ev_share', 'wb_patents_pc', 'wb_science_articles_pc', 'wb_rnd_gdp', 'wb_hightech_exports', 'owid_space_objects'],
  },
  {
    key: 'nature', name: 'Nature',
    titles: ['More Cows Than People? 10 Maps of Land and Nature', '10 Maps That Show the World’s Land, Water and Animals', 'The World’s Nature in 10 Maps'],
    quiz: ['More Cows Than People? 10-Round Map Quiz of Land and Nature', 'Nature Map Quiz: 10 Rounds Against the Clock', 'Guess the Country: 10 Maps of Land, Water and Animals'],
    intro: 'Ten maps of land and nature. Who has the most forest, the most water, and more animals than people.',
    question: 'Which of these 10 maps surprised you most?',
    tags: ['world maps', 'nature', 'forest by country', 'livestock per person', 'data visualization', 'geography'],
    datasets: ['owid_cattle_pc', 'owid_chickens_pc', 'owid_pigs_pc', 'wb_forest_share', 'wb_forest_pc', 'wb_freshwater_pc', 'wb_rainfall', 'wb_protected_areas', 'wb_arable_pc', 'owid_plastic_waste', 'wb_farmland_share'],
  },
];

export function themeByKey(key: string): Theme | undefined {
  return THEMES.find((t) => t.key === key.toLowerCase());
}
