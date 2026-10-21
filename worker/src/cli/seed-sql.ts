// Writes sql/seed_launch_concepts.sql from src/data/concepts.ts.
import fs from 'node:fs/promises';
import { CONCEPTS } from '../data/concepts.js';
import { angleHash } from '../discover.js';

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const rows = CONCEPTS.map((c, i) =>
  `  (${lit(c.dataset)}, ${lit(c.question)}, ${lit(c.twist)}, ${lit(c.format)}, ${1000 - i}, ${lit(angleHash(c.question))}, 'launch', ${lit(c.key)})`);
const sql = `-- The 10 launch concepts from the plan, queued at top priority.
-- Run: docker compose exec -T postgres psql -U percapita -d percapita < app/sql/seed_launch_concepts.sql
-- Safe to run twice. Concepts whose dataset failed the live check are skipped.
INSERT INTO topics (dataset_id, question, expected_twist, format, priority, angle_hash, source, concept_key)
SELECT v.* FROM (VALUES
${rows.join(',\n')}
) AS v(dataset_id, question, expected_twist, format, priority, angle_hash, source, concept_key)
JOIN datasets d ON d.id = v.dataset_id AND d.enabled
ON CONFLICT (dataset_id, angle_hash) DO NOTHING;

SELECT t.concept_key, t.question, t.status FROM topics t WHERE t.source = 'launch' ORDER BY t.priority DESC;
`;
await fs.writeFile(new URL('../../../sql/seed_launch_concepts.sql', import.meta.url), sql);
console.log('wrote sql/seed_launch_concepts.sql');
