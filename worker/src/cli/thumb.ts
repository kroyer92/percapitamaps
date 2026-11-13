// `npm run thumb -- --longform 1`: draw long-form #1's thumbnail again (from its saved props)
// to renders/longform-1-thumb.png. Works for both styles: the map quiz and the classic one.
import fs from 'node:fs/promises';
import path from 'node:path';
import { arg } from './args.js';
import { longDir, longThumb, renderThumb } from '../longform/make.js';
import { quizThumb } from '../longform/game-time.js';
import type { LongformProps } from '../../remotion/longform-types.js';
import type { GameProps } from '../../remotion/game-types.js';

const n = Number(arg('longform'));
if (!n) throw new Error('Use: npm run thumb -- --longform 1');
const props = JSON.parse(await fs.readFile(path.join(longDir(n), 'props.json'), 'utf8')) as LongformProps | GameProps;
if ('rounds' in props) {
  await renderThumb(quizThumb(props.themeName, props.rounds.length, props.rounds[0].map), longThumb(n));
} else {
  const first = props.segments[0];
  await renderThumb({ line1: `${props.count} MAPS`, line2: `OF ${props.themeName.toUpperCase()}`, line3: "WHO'S #1?", map: first.map, answerIso: first.top[0]?.iso3 }, longThumb(n));
}
console.log(`Saved ${longThumb(n)}`);
