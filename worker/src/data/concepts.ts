// The 10 launch concepts from the plan (section C1). `npm run seed-sql` writes
// sql/seed_launch_concepts.sql from this list; test-render uses it directly.
import type { Format } from '../config.js';

export interface Concept { key: string; dataset: string; format: Format; question: string; twist: string; trend?: string }

export const CONCEPTS: Concept[] = [
  { key: 'sheep', dataset: 'owid_sheep_pc', format: 'MAP_REVEAL', question: 'Which countries have more sheep than people?', twist: "Everyone thinks it's only New Zealand; several countries have more sheep than people." },
  { key: 'height', dataset: 'owid_height_men', format: 'COUNTDOWN', question: 'Which country has the tallest men?', twist: 'The tallest people on Earth are not American; Europe dominates the top.' },
  { key: 'hours', dataset: 'owid_working_hours', format: 'MAP_REVEAL', question: 'Which country works the most hours a year?', twist: "Japan doesn't work the longest hours. Not even close." },
  { key: 'co2', dataset: 'owid_co2_pc', format: 'COUNTDOWN', question: 'Who emits the most CO₂ per person?', twist: 'Small rich states out-pollute the US and China per person.' },
  { key: 'people100', dataset: 'wb_population', format: 'SCALE', question: 'If the world were 100 people, where would they live?', twist: 'More than a third would live in just two countries.' },
  { key: 'gdp', dataset: 'wb_gdp_pc_ppp', format: 'COUNTDOWN', question: 'Which countries are richest, adjusted for prices?', twist: 'The richest country per person is not the US.' },
  { key: 'dollars100', dataset: 'wb_100_dollars', format: 'MAP_REVEAL', question: 'Where does $100 go furthest?', twist: 'The same $100 buys several times more in some countries.' },
  { key: 'lifeexp', dataset: 'owid_life_expectancy', format: 'THEN_NOW', question: 'How long did people live, then and now?', twist: 'Every country now lives longer than the best country did in 1950.' },
  { key: 'meat', dataset: 'owid_meat', format: 'GUESS', question: 'Which country eats the most meat per person?', twist: "It isn't the US or Argentina." },
  { key: 'internet', dataset: 'owid_internet', format: 'THEN_NOW', question: 'How fast did the world get online?', twist: 'The fastest country to get online is not who you would think.' },
];
