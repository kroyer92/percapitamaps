// Try the comment drafts on live data without the database or Telegram:
//   npm run comments-try -- wb_100_dollars "What about Uganda Madagascar and Vietnam"
import { CATALOG } from '../data/catalog.js';
import { loadFacts } from '../facts.js';
import { draftFor } from '../comment-draft.js';

const [id, ...texts] = process.argv.slice(2);
const ds = CATALOG.find((d) => d.id === id);
if (!ds || !texts.length) {
  console.error('Usage: npm run comments-try -- <dataset id> "comment" ["another comment" ...]');
  process.exit(1);
}
const facts = await loadFacts(ds, 'MAP_REVEAL');
for (const t of texts) {
  const d = draftFor(t, facts, ds);
  console.log(`\n> ${t}\n  [${d.kind}] ${d.action}${d.reply ? `\n  ${d.reply}` : ''}`);
}
