// `npm run longform`: make the long-form video now, outside the bot (the bot's /longform does the
// same inside the work lane, so it never overlaps a Short; prefer that).
//   npm run longform                      the theme the Shorts' views point to
//   npm run longform -- --theme health    a theme of your choice
//   npm run longform -- --classic         the classic style this once (--game: the map quiz)
//   npm run longform -- --plan            only print the maps and the script, no voice or render
import { pool, q } from '../db.js';
import { arg } from './args.js';
import { makeLongform } from '../longform/make.js';
import { chooseTheme, pickMaps, planLongform } from '../longform/plan.js';
import { GAME_MIN_ROUNDS, gameUnusable, planGame, roundsWanted } from '../longform/game.js';
import { gameScript } from '../longform/game-time.js';
import { longformStyle, type LongStyle } from '../longform/score.js';
import { themeByKey } from '../longform/themes.js';
import { getDataset } from '../datasets.js';

const theme = arg('theme');
const asked = arg('maps') ?? arg('top'); // --top 10 --days 14 (the launch checklist's wording) still works
const maps = asked ? Number(asked) : undefined;
const style: LongStyle | undefined = process.argv.includes('--classic') ? 'classic' : process.argv.includes('--game') ? 'game' : undefined;
if (process.argv.includes('--plan')) {
  const t = theme ? themeByKey(theme) : chooseTheme(new Map(), []);
  if (!t) throw new Error(`Unknown theme ${theme}`);
  const lookup = async (id: string) => { const r = (await q<{ enabled: boolean }>('SELECT enabled FROM datasets WHERE id = $1', [id]))[0]; return r?.enabled ? getDataset(id) : undefined; };
  if ((style ?? await longformStyle()) === 'game') {
    const { picked, skipped } = await pickMaps({ theme: t, viewsByDataset: new Map(), lookup, want: roundsWanted(maps), min: GAME_MIN_ROUNDS, onStep: (s) => console.log(s), skip: gameUnusable });
    console.log(`\n${gameScript(planGame(t, picked, skipped))}`);
    if (skipped.length) console.log(`\nLeft out: ${skipped.join('\n  ')}`);
  } else {
    const plan = await planLongform({ theme: t, viewsByDataset: new Map(), maps, lookup, onStep: (s) => console.log(s) });
    for (const b of plan.intro) console.log(`[intro] ${b.vo}`);
    for (const s of plan.segments) for (const b of s.beats) console.log(`[map ${s.n} · ${b.visual}] ${b.vo}`);
    for (const b of plan.outro) console.log(`[outro] ${b.vo}`);
    if (plan.skipped.length) console.log(`\nLeft out: ${plan.skipped.join('\n  ')}`);
  }
} else {
  const n = await makeLongform({ theme, maps, style });
  console.log(n ? `Long-form #${n} done; see Telegram.` : 'Nothing made.');
}
await pool.end();
