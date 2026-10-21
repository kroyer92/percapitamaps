// Renders a job's video: Remotion draws the frames, ffmpeg adds voice and music.
import fs from 'node:fs/promises';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { config, type Format } from './config.js';
import { iso3ToIso2 } from './data/countries.js';
import { formatValue, type Facts } from './facts.js';
import type { CatalogEntry } from './data/catalog.js';
import type { Beat } from './validate.js';
import { synthesize, type VoiceClip } from './voice.js';
import { place, timedBeats, FPS } from './timeline.js';
import { buildVoiceTrack, finalMix, pickMusic, type MusicPick } from './audio.js';
import type { ShortProps } from '../remotion/types.js';

let bundlePromise: Promise<string> | undefined;

async function serveUrl(): Promise<string> {
  try {
    await fs.access(path.join(config.bundleDir, 'index.html'));
    return config.bundleDir;
  } catch {
    bundlePromise ??= bundle({ entryPoint: path.resolve('remotion/index.ts') });
    return bundlePromise;
  }
}

export function buildProps(format: Format, facts: Facts, ds: Pick<CatalogEntry, 'decimals' | 'prefix' | 'suffix' | 'threshold'>, beats: ShortProps['beats'], durationInFrames: number): ShortProps {
  const top = facts.ranking.slice(0, 15);
  const anchorRows = facts.ranking.filter((r) => r.iso3 in facts.anchors && !top.includes(r));
  const ranking = [...top, ...anchorRows].map((r) => ({ ...r, iso2: iso3ToIso2(r.iso3) }));
  const props: ShortProps = {
    format,
    durationInFrames,
    kicker: `${facts.title} · ${facts.year}`,
    beats,
    ranking,
    map: facts.map,
    highlightIso: facts.guess ? facts.guess.options.find((o) => o.letter === facts.guess!.answer)?.iso3 : facts.ranking[0]?.iso3,
    threshold: ds.threshold,
    sourceLine: facts.source_line,
    handle: config.channelHandle,
  };
  if (facts.series) {
    props.series = {
      years: facts.series.years,
      countries: facts.series.countries.map((c) => ({ ...c, iso2: iso3ToIso2(c.iso3) })),
      decimals: ds.decimals ?? 0,
      prefix: ds.prefix ?? '',
      suffix: ds.suffix ?? '',
    };
  }
  if (facts.scale) props.scale = { groups: facts.scale.groups.map((g) => ({ ...g, iso2: g.iso3 ? iso3ToIso2(g.iso3) : undefined })), per: facts.scale.per };
  if (facts.guess) {
    props.guess = {
      answer: facts.guess.answer,
      options: facts.guess.options.map((o) => {
        const r = facts.ranking.find((x) => x.iso3 === o.iso3)!;
        return { ...o, iso2: iso3ToIso2(o.iso3), display: r ? formatValue(r.value, ds) : '' };
      }),
    };
  }
  return props;
}

export interface RenderResult { video: string; seconds: number; props: ShortProps; music?: MusicPick; clips: VoiceClip[] }

export async function renderShort(opts: {
  workDir: string;
  outFile: string;
  format: Format;
  facts: Facts;
  ds: Pick<CatalogEntry, 'decimals' | 'prefix' | 'suffix' | 'threshold'>;
  beats: Beat[];
  voice: string;
  seed: number;
  reuseClips?: VoiceClip[]; // when only the hook changed, re-voice beat 1 only
  onProgress?: (p: number) => void;
}): Promise<RenderResult> {
  const { workDir, outFile } = opts;
  await fs.mkdir(workDir, { recursive: true });

  const voiceDir = path.join(workDir, 'voice');
  let clips: VoiceClip[];
  if (opts.reuseClips && opts.reuseClips.length === opts.beats.length) {
    const [first] = await synthesize([{ id: `b00-${Date.now()}`, text: opts.beats[0].vo }], opts.voice, voiceDir);
    clips = [first, ...opts.reuseClips.slice(1)];
  } else {
    clips = await synthesize(opts.beats.map((b, i) => ({ id: `b${String(i).padStart(2, '0')}`, text: b.vo })), opts.voice, voiceDir);
  }

  const { placed, seconds } = place(opts.beats, clips);
  const durationInFrames = Math.ceil(seconds * FPS);
  const props = buildProps(opts.format, opts.facts, opts.ds, timedBeats(placed, seconds), durationInFrames);
  await fs.writeFile(path.join(workDir, 'props.json'), JSON.stringify(props));

  const voiceTrack = path.join(workDir, 'voice.wav');
  await buildVoiceTrack(placed, seconds, voiceTrack);

  const url = await serveUrl();
  const composition = await selectComposition({ serveUrl: url, id: 'Short', inputProps: props as any, browserExecutable: process.env.REMOTION_BROWSER || null });
  const silent = path.join(workDir, 'silent.mp4');
  await renderMedia({
    composition,
    serveUrl: url,
    codec: 'h264',
    crf: 18,
    pixelFormat: 'yuv420p',
    muted: true,
    outputLocation: silent,
    inputProps: props as any,
    concurrency: config.renderThreads,
    browserExecutable: process.env.REMOTION_BROWSER || null,
    onProgress: ({ progress }) => opts.onProgress?.(progress),
  });

  const music = await pickMusic(opts.seed);
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await finalMix(silent, voiceTrack, music, seconds, outFile);
  await fs.rm(silent, { force: true });
  return { video: outFile, seconds, props, music, clips };
}
