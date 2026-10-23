import React from 'react';
import { WorldMap, mapCues } from '../components/WorldMap';
import type { ShortProps } from '../types';

export const MapReveal: React.FC<{ p: ShortProps }> = ({ p }) => {
  const byIso = new Map(p.ranking.map((r) => [r.iso3, r]));
  return (
    <WorldMap
      map={p.map}
      cues={mapCues(p.beats, p.highlightIso)}
      threshold={p.threshold?.value}
      thresholdLabel={p.threshold?.label}
      unit={p.unit}
      answerIso={p.highlightIso}
      labelFor={(iso) => {
        const r = byIso.get(iso);
        return r ? `#${r.rank} ${r.name} · ${r.display}` : undefined;
      }}
    />
  );
};
