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
  // Countdown and Guess open with one text: the headline is the hook the voice says, each word
  // lighting up as it is spoken. No question beside it, no caption under it, and the kicker waits
  // until the hook is over. (The first frame used to carry three texts, about 15 to 20 words.)
  const one = !strip && (p.format === 'COUNTDOWN' || p.format === 'GUESS') && !!p.beats[0]?.vo;
  const hookEnd = p.beats[1]?.start ?? 60;
  const beats = strip ? p.beats.map((b, i) => (i === 0 ? { ...b, on_screen: '', words: [] } : b))
    : one ? p.beats.map((b, i) => (i === 0 ? { ...b, on_screen: b.vo, words: [] } : b)) : p.beats;
  return (
    <AbsoluteFill>
      <Background />
      <Visual p={p} />
      {strip ? <Kicker text={p.kicker} top={STRIP.kicker} from={hookEnd} /> : <Kicker text={p.kicker} from={one ? hookEnd : 0} />}
      <Headline beats={beats} low={strip} spoken={one ? p.beats[0].words : undefined} />
      <Captions beats={beats} />
      <SourceLine text={p.sourceLine} from={sourceFrom(p)} handle={p.handle} />
      {strip && <RankStripOpening p={p} />}
    </AbsoluteFill>
  );
};
