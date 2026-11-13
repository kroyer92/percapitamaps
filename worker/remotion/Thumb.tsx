// The long-form thumbnail (1280x720): the first map in blue and three big words. The classic video
// shows the map's #1 in amber, unnamed. The game shows a big question mark instead: its first map
// is round 1, so an amber country would give that answer away. Rendered as a still.
import React, { useEffect, useState } from 'react';
import { AbsoluteFill, continueRender, delayRender } from 'remotion';
import '@fontsource/inter/900.css';
import { C, FONT } from './theme';
import { LandMap } from './components/LandMap';
import type { ThumbProps } from './longform-types';

export const Thumb: React.FC<ThumbProps> = (p) => {
  const [handle] = useState(() => delayRender('fonts'));
  useEffect(() => { document.fonts.ready.then(() => continueRender(handle)); }, [handle]);
  return (
    <AbsoluteFill style={{ background: `radial-gradient(110% 90% at 30% 50%, ${C.bg} 0%, ${C.bgDeep} 100%)`, overflow: 'hidden' }}>
      {/* The map is drawn at the video's size and scaled into the left of the thumbnail. */}
      <div style={{ position: 'absolute', left: -60, top: -10, width: 1920, height: 1080, transform: 'scale(0.78)', transformOrigin: 'top left' }}>
        {p.quiz
          ? <LandMap map={p.map} cues={[{ kind: 'fill', start: 0 }]} fillFrom={-100} drift={false} />
          : <LandMap map={p.map} cues={[{ kind: 'fill', start: 0 }, { kind: 'reveal', iso: p.answerIso, start: 0 }]} answerIso={p.answerIso} fillFrom={-100} drift={false} />}
      </div>
      {p.quiz && (
        <div style={{ position: 'absolute', left: 190, top: 170, width: 380, height: 380, borderRadius: 190, background: C.amber, border: `10px solid ${C.bgDeep}`, boxSizing: 'border-box', boxShadow: '0 10px 60px rgba(0,0,0,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT, fontSize: 300, fontWeight: 900, color: C.bgDeep, lineHeight: 1 }}>?</div>
      )}
      <AbsoluteFill style={{ background: 'linear-gradient(90deg, rgba(10,29,43,0) 35%, rgba(10,29,43,0.92) 62%)' }} />
      <div style={{ position: 'absolute', right: 50, top: 0, bottom: 0, width: 560, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-end', fontFamily: FONT, fontWeight: 900, textAlign: 'right' }}>
        <div style={{ fontSize: 136, lineHeight: 0.95, color: C.pale, textShadow: '0 6px 30px rgba(0,0,0,0.6)' }}>{p.line1}</div>
        <div style={{ fontSize: 92, lineHeight: 1.05, color: C.blue, textShadow: '0 6px 30px rgba(0,0,0,0.6)' }}>{p.line2}</div>
        <div style={{ fontSize: 84, lineHeight: 1.1, color: C.amber, marginTop: 14, textShadow: '0 6px 30px rgba(0,0,0,0.6)' }}>{p.line3}</div>
      </div>
    </AbsoluteFill>
  );
};
