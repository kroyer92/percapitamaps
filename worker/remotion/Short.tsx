import React, { useEffect, useState } from 'react';
import { AbsoluteFill, continueRender, delayRender } from 'remotion';
import '@fontsource/inter/500.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/inter/900.css';
import { Background, Captions, Headline, Kicker, SourceLine, sourceFrom } from './components/Chrome';
import { MapReveal } from './formats/MapReveal';
import { Countdown } from './formats/Countdown';
import { ThenNow } from './formats/ThenNow';
import { Scale } from './formats/Scale';
import { Guess } from './formats/Guess';
import { RankStripOpening, STRIP } from './components/RankStrip';
import type { ShortProps } from './types';

export const Short: React.FC<ShortProps> = (p) => {
  const [handle] = useState(() => delayRender('fonts'));
  useEffect(() => {
    document.fonts.ready.then(() => continueRender(handle));
  }, [handle]);
  const Visual = { MAP_REVEAL: MapReveal, COUNTDOWN: Countdown, THEN_NOW: ThenNow, SCALE: Scale, GUESS: Guess }[p.format];
  // The rank strip opening shows the hook's words itself, so the hook gets no headline or captions,
  // and the kicker waits under the strip until the hook is over.
  const strip = p.format === 'MAP_REVEAL' && !!p.opening;
  const beats = strip ? p.beats.map((b, i) => (i === 0 ? { ...b, on_screen: '', words: [] } : b)) : p.beats;
  return (
    <AbsoluteFill>
      <Background />
      <Visual p={p} />
      {strip ? <Kicker text={p.kicker} top={STRIP.kicker} from={p.beats[1]?.start ?? 60} /> : <Kicker text={p.kicker} />}
      <Headline beats={beats} low={strip} />
      <Captions beats={beats} />
      <SourceLine text={p.sourceLine} from={sourceFrom(p)} handle={p.handle} />
      {strip && <RankStripOpening p={p} />}
    </AbsoluteFill>
  );
};
