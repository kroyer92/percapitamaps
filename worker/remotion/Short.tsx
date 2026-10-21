import React, { useEffect, useState } from 'react';
import { AbsoluteFill, continueRender, delayRender } from 'remotion';
import '@fontsource/inter/500.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import { Background, Captions, Headline, Kicker, SourceLine, sourceFrom } from './components/Chrome';
import { MapReveal } from './formats/MapReveal';
import { Countdown } from './formats/Countdown';
import { ThenNow } from './formats/ThenNow';
import { Scale } from './formats/Scale';
import { Guess } from './formats/Guess';
import type { ShortProps } from './types';

export const Short: React.FC<ShortProps> = (p) => {
  const [handle] = useState(() => delayRender('fonts'));
  useEffect(() => {
    document.fonts.ready.then(() => continueRender(handle));
  }, [handle]);
  const Visual = { MAP_REVEAL: MapReveal, COUNTDOWN: Countdown, THEN_NOW: ThenNow, SCALE: Scale, GUESS: Guess }[p.format];
  return (
    <AbsoluteFill>
      <Background />
      <Visual p={p} />
      <Kicker text={p.kicker} />
      <Headline beats={p.beats} />
      <Captions beats={p.beats} />
      <SourceLine text={p.sourceLine} from={sourceFrom(p)} handle={p.handle} />
    </AbsoluteFill>
  );
};
