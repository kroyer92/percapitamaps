-- The 10 launch concepts from the plan, queued at top priority.
-- Run: docker compose exec -T postgres psql -U percapita -d percapita < app/sql/seed_launch_concepts.sql
-- Safe to run twice. Concepts whose dataset failed the live check are skipped.
INSERT INTO topics (dataset_id, question, expected_twist, format, priority, angle_hash, source, concept_key)
SELECT v.* FROM (VALUES
  ('owid_cattle_pc', 'Which countries have more cows than people?', 'A few countries have more cattle than people, and the leader has more than three per person.', 'MAP_REVEAL', 1000, '79653ce3bf1434b5', 'launch', 'cattle'),
  ('owid_height_men', 'Which country has the tallest men?', 'The tallest people on Earth are not American; Europe dominates the top.', 'COUNTDOWN', 999, '880adf075c6d2c79', 'launch', 'height'),
  ('owid_working_hours', 'Which country works the most hours a year?', 'Japan doesn''t work the longest hours. Not even close.', 'MAP_REVEAL', 998, '37e50b439b1759d4', 'launch', 'hours'),
  ('owid_co2_pc', 'Who emits the most CO₂ per person?', 'Small rich states out-pollute the US and China per person.', 'COUNTDOWN', 997, '03442def85253be9', 'launch', 'co2'),
  ('wb_population', 'If the world were 100 people, where would they live?', 'More than a third would live in just two countries.', 'SCALE', 996, '6a32ff898df3b346', 'launch', 'people100'),
  ('wb_gdp_pc_ppp', 'Which countries are richest, adjusted for prices?', 'The richest country per person is not the US.', 'COUNTDOWN', 995, '73c882a4905886c1', 'launch', 'gdp'),
  ('wb_100_dollars', 'Where does $100 go furthest?', 'The same $100 buys several times more in some countries.', 'MAP_REVEAL', 994, 'feb12068478e554b', 'launch', 'dollars100'),
  ('owid_life_expectancy', 'How long did people live, then and now?', 'Every country now lives longer than the best country did in 1950.', 'THEN_NOW', 993, '14a6b021bf56766d', 'launch', 'lifeexp'),
  ('owid_meat', 'Which country eats the most meat per person?', 'It isn''t the US or Argentina.', 'GUESS', 992, '0adee8e807f22844', 'launch', 'meat'),
  ('owid_internet', 'How fast did the world get online?', 'The fastest country to get online is not who you would think.', 'THEN_NOW', 991, 'aba32563f484a1ce', 'launch', 'internet')
) AS v(dataset_id, question, expected_twist, format, priority, angle_hash, source, concept_key)
JOIN datasets d ON d.id = v.dataset_id AND d.enabled
ON CONFLICT (dataset_id, angle_hash) DO NOTHING;

SELECT t.concept_key, t.question, t.status FROM topics t WHERE t.source = 'launch' ORDER BY t.priority DESC;
