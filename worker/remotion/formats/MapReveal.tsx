import React from 'react';
import { AnswerNumber, WorldMap, camFor, mapCues } from '../components/WorldMap';
import { W } from '../theme';
import type { ShortProps } from '../types';

export const MapReveal: React.FC<{ p: ShortProps }> = ({ p }) => {
  const byIso = new Map(p.ranking.map((r) => [r.iso3, r]));
  const cues = mapCues(p.beats, p.highlightIso);
  const reveal = cues.find((c) => c.kind === 'reveal');
  const answer = p.highlightIso ? byIso.get(p.highlightIso) : undefined;
  // The closer goes back to the world view; the number stays only while the camera is on the answer.
  const after = cues.find((c) => reveal && c.start > reveal.start);
  // The rank strip opening starts zoomed in on its country, low enough to leave room for the badge
  // above it, and creeping closer; the key waits until the hook is over.
  const hookEnd = p.beats[1]?.start ?? 60;
  const c = p.opening ? camFor(p.opening.iso, 190, { w: W * 0.8, h: 470 }) : undefined;
  const intro = c && p.opening ? { until: hookEnd, cam: (f: number) => ({ ...c, k: c.k * (1 + 0.06 * (f / hookEnd)) }), outlineIso: p.opening.iso } : undefined;
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
        intro={intro}
        keyFrom={intro ? hookEnd : 0}
      />
      {reveal && answer && <AnswerNumber display={answer.display} unit={p.unit} start={reveal.start} end={after?.start} />}
    </>
  );
};
