import React from 'react';
import { Composition, Still } from 'remotion';
import { Short } from './Short';
import { Longform } from './Longform';
import { Thumb } from './Thumb';
import { Nation } from './nation/Nation';
import { nationSample } from './nation/sample';
import type { NationProps } from './nation/types';
import { sampleProps } from './sample';
import type { ShortProps } from './types';
import type { LongformProps, ThumbProps } from './longform-types';

const longSample: LongformProps = { durationInFrames: 90, themeName: 'Sample', count: 0, beats: [], segments: [], handle: '@PerCapitaMaps' };
const thumbSample: ThumbProps = { line1: '10 MAPS', line2: 'OF SAMPLE', line3: "WHO'S #1?", map: {} };

export const Root: React.FC = () => (
  <>
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
    {/* The weekly long-form video (src/longform). */}
    <Composition
      id="Longform"
      component={Longform as React.FC<any>}
      width={1920}
      height={1080}
      fps={30}
      durationInFrames={longSample.durationInFrames}
      defaultProps={longSample}
      calculateMetadata={({ props }) => ({ durationInFrames: (props as unknown as LongformProps).durationInFrames })}
    />
    {/* Per Capita Nation, the daily census Short (src/nation). */}
    <Composition
      id="Nation"
      component={Nation as React.FC<any>}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={nationSample.durationInFrames}
      defaultProps={nationSample}
      calculateMetadata={({ props }) => ({ durationInFrames: (props as unknown as NationProps).durationInFrames })}
    />
    <Still id="LongformThumb" component={Thumb as React.FC<any>} width={1280} height={720} defaultProps={thumbSample} />
  </>
);
