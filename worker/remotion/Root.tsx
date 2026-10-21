import React from 'react';
import { Composition } from 'remotion';
import { Short } from './Short';
import { sampleProps } from './sample';
import type { ShortProps } from './types';

export const Root: React.FC = () => (
  <Composition
    id="Short"
    component={Short as React.FC<any>}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={sampleProps.durationInFrames}
    defaultProps={sampleProps}
    calculateMetadata={({ props }) => ({ durationInFrames: (props as unknown as ShortProps).durationInFrames })}
  />
);
