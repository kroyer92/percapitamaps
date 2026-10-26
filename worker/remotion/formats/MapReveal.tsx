import React from 'react';
import { AnswerNumber, WorldMap, mapCues } from '../components/WorldMap';
import type { ShortProps } from '../types';

export const MapReveal: React.FC<{ p: ShortProps }> = ({ p }) => {
  const byIso = new Map(p.ranking.map((r) => [r.iso3, r]));
  const cues = mapCues(p.beats, p.highlightIso);
  const reveal = cues.find((c) => c.kind === 'reveal');
  const answer = p.highlightIso ? byIso.get(p.highlightIso) : undefined;
  // The closer goes back to the world view; the number stays only while the camera is on the answer.
  const after = cues.find((c) => reveal && c.start > reveal.start);
  return (
    <>
      <WorldMap
        map={p.map}
        cues={cues}
        threshold={p.threshold?.value}
        thresholdLabel={p.threshold?.label}
        unit={p.unit}
        answerIso={p.highlightIso}
        labelFor={(iso) => {
          const r = byIso.get(iso);
          return r ? `#${r.rank} ${r.name} · ${r.display}` : undefined;
        }}
      />
      {reveal && answer && <AnswerNumber display={answer.display} unit={p.unit} start={reveal.start} end={after?.start} />}
    </>
  );
};
