import React from 'react';
import * as Flags from 'country-flag-icons/string/3x2';

const flags = Flags as unknown as Record<string, string>;

export const Flag: React.FC<{ iso2?: string; height: number; style?: React.CSSProperties }> = ({ iso2, height, style }) => {
  const svg = iso2 ? flags[iso2.toUpperCase()] : undefined;
  const width = (height * 3) / 2;
  if (!svg) return <div style={{ width, height, borderRadius: 4, background: 'rgba(255,255,255,0.12)', ...style }} />;
  return (
    <img
      src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
      style={{ width, height, borderRadius: 4, boxShadow: '0 0 0 1px rgba(255,255,255,0.18)', objectFit: 'cover', ...style }}
    />
  );
};
