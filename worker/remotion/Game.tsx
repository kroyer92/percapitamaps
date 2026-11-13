// The weekly long-form video as a game (1920x1080). A cold open teases the surprises, then every
// map is a round: the viewer guesses before a timer runs out, the answer lands, their own country
// shows up, and one more fact closes the round. It ends on the country in the most top tens and
// the viewer's score. The script and every frame number come from src/longform/game.ts and
// game-time.ts; this file only draws them.
import React, { useEffect, useMemo, useState } from 'react';
import { AbsoluteFill, continueRender, delayRender, interpolate, interpolateColors, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import '@fontsource/inter/500.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/inter/900.css';
import { C, FONT } from './theme';
import { Flag } from './components/Flag';
import { GameMap, LM, type CamCue } from './components/GameMap';
import { countScale, DEEP, quantiles, waveOrder } from './game/colors';
import { COUNT_UP, lapseSteps, ownChips } from './game-schedule';
import {
  Bg, BigCard, Captions, CARD, Chip, clamp, countUp, fade, fit, Header, Key, LessMore, LINE, LW, Option, Panel, PanelTitle, PlusOne, Pop, PW, PX, PY,
  RankRow, Rounds, Stinger, Swatch, Timer,
} from './game/parts';
import type { GameProps, GameRound, Phase, Teaser } from './game-types';

// What the map shows on one frame.
interface MapView {
  fills: Record<string, string>;
  cam: CamCue[];
  outlines: string[];
  active?: { iso: string; at: number; amber?: boolean };
  dim: number;
  yearIdx: number; // then and now: which year is on the map
  counted: number; // countries lit amber so far
}
interface Prep { q: ReturnType<typeof quantiles>; scale?: ReturnType<typeof countScale>; wave: string[] }

const emptyView = (): MapView => ({ fills: {}, cam: [], outlines: [], dim: 0, yearIdx: 0, counted: 0 });

// The frames a phase's panel is up: from its start to the next phase (or the round's end).
function span(r: GameRound, key: Phase['key']): { from: number; to: number } | undefined {
  const i = r.phases.findIndex((x) => x.key === key);
  return i < 0 ? undefined : { from: r.phases[i].from, to: r.phases[i + 1]?.from ?? r.end };
}

// The amber wave: counted country number i of n lights up this many frames after the wave starts.
const waveDelay = (i: number, n: number) => (i / Math.max(1, n)) * COUNT_UP;

function roundView(r: GameRound, prep: Prep, frame: number): MapView {
  const q = r.cue;
  const at = (k: string) => q[k] ?? Infinity;
  const one = r.top[0];
  const view = emptyView();
  const { fills } = view;
  const own = span(r, 'own');
  const inOwn = !!own && frame >= own.from && frame < own.to;
  view.cam = [{ at: r.start - 4 }];

  if (r.kind === 'then_now' && r.count && prep.scale) {
    const { count } = r;
    const { counted, shade } = prep.scale;
    const steps = lapseSteps(r);
    const last = count.years.length - 1;
    const idx = steps.filter((s, i) => i > 0 && frame >= s).length;
    const next = idx < last && frame > steps[idx + 1] - 10 ? idx + 1 : idx;
    const waveFrom = q['then.count'] ?? q.then ?? r.start;
    const lit = (iso: string) => frame >= waveFrom + waveDelay(prep.wave.indexOf(iso), prep.wave.length);
    // While the question is up the map holds the countries counted in every year shown. Once the
    // count is told, today's whole map in the usual blues, with the highest country in amber.
    const after = r.phases[1]?.from ?? Infinity;
    const colorIn = (k: number, iso: string) => {
      const v = count.maps[k][iso];
      if (v === undefined) return C.land;
      if (!counted(v)) return shade(v);
      return k > 0 || lit(iso) ? C.amber : DEEP;
    };
    const hi = r.extremes?.high;
    const lo = r.extremes?.low;
    if (frame < after) {
      for (const iso of Object.keys(count.maps[0])) {
        fills[iso] = next === idx ? colorIn(idx, iso) : interpolateColors(frame, [steps[next] - 10, steps[next]], [colorIn(idx, iso), colorIn(next, iso)]);
      }
    } else {
      for (const iso of Object.keys(r.map)) {
        const was = count.maps[last][iso] === undefined ? C.land : colorIn(last, iso);
        fills[iso] = interpolateColors(frame, [after, after + 10], [was, prep.q.colors[iso]]);
      }
      if (hi && frame >= at('ext.high') - 8) fills[hi.iso3] = C.amber;
    }
    view.yearIdx = idx;
    view.counted = idx > 0 ? count.counts[idx] : prep.wave.filter(lit).length;
    if (hi && q['ext.high'] !== undefined) view.cam.push({ at: q['ext.high'] - 8, iso: hi.iso3 });
    if (lo && q['ext.low'] !== undefined) view.cam.push({ at: q['ext.low'] - 8, iso: lo.iso3, zoom: 0.8 });
    if (own) view.cam.push({ at: own.from });
    if (!inOwn) {
      if (lo && frame >= at('ext.low') - 8) view.active = { iso: lo.iso3, at: at('ext.low') - 8 };
      else if (hi && frame >= at('ext.high') - 8) view.active = { iso: hi.iso3, at: at('ext.high') - 8, amber: true };
    }
  } else {
    const fill = interpolate(frame, [r.start + 4, r.start + 44], [0, 1], clamp);
    for (const iso of Object.keys(r.map)) if (fill >= prep.q.order[iso] * 0.9) fills[iso] = prep.q.colors[iso];
    if (r.kind === 'pick') {
      if (frame >= at('reveal')) fills[one.iso3] = C.amber;
      view.cam.push({ at: at('reveal'), iso: one.iso3 }, { at: at('ladder') - 8 });
      if (r.lowIso && q['compare.low'] !== undefined) view.cam.push({ at: q['compare.low'] - 8, iso: r.lowIso, zoom: 0.5 });
      if (!inOwn) {
        if (r.lowIso && frame >= at('compare.low') - 8) view.active = { iso: r.lowIso, at: at('compare.low') - 8 };
        else if (frame >= at('reveal') && frame < (own?.from ?? span(r, 'compare')?.from ?? Infinity)) view.active = { iso: one.iso3, at: at('reveal'), amber: true };
      }
    } else {
      // How many, higher or lower: the top five come after the answer, and the map flies to #1 for them.
      const toOne = at('ladder.1') - 6;
      view.cam.push({ at: toOne, iso: one.iso3 }, { at: at('ladder.2') - 6 });
      if (r.kind === 'how_many' && r.count) {
        const from = at('reveal');
        prep.wave.forEach((iso, i) => { if (frame >= from + waveDelay(i, prep.wave.length)) { fills[iso] = C.amber; view.counted++; } });
      }
      if (r.kind === 'higher_lower' && r.duel && frame < at('ladder') - 8) {
        if (frame >= at('duel.ref')) view.outlines = [r.duel.ref.iso3];
        if (frame >= at('duel.target')) view.active = { iso: r.duel.target.iso3, at: at('duel.target'), amber: frame >= at('reveal') };
        if (frame >= at('reveal')) fills[r.duel.target.iso3] = C.amber;
      }
      if (frame >= toOne) {
        fills[one.iso3] = C.amber;
        if (!inOwn) view.active = { iso: one.iso3, at: toOne, amber: true };
      }
    }
  }

  if (inOwn) {
    // The viewer's own countries get a thin outline as their chips pop; the one being named glows.
    view.outlines = ownChips(r).filter((c) => frame >= c.at).map((c) => c.chip.iso3);
    const named = [1, 0].map((i) => ({ iso: r.ownNamed[i], at: q[`own.${i}`] })).find((x) => x.iso && x.at !== undefined && frame >= x.at);
    if (named) view.active = { iso: named.iso, at: named.at };
  }
  return view;
}

function teaserView(p: GameProps, t: Teaser, prep: Prep[], frame: number): MapView {
  const view = emptyView();
  const i = p.teasers.indexOf(t);
  // A card without a map of its own (the promise, the rules) keeps the map before it, dimmed.
  const base = [...p.teasers.slice(0, i + 1)].reverse().find((x) => x.round !== undefined) ?? p.teasers.find((x) => x.round !== undefined);
  const r = base?.round !== undefined ? p.rounds[base.round] : undefined;
  if (base && r) {
    const pr = prep[base.round!];
    if (base.kind === 'count' && r.count && pr.scale) {
      const hit = base.cue.hit ?? base.start;
      for (const [iso, v] of Object.entries(r.count.maps[0])) {
        if (!pr.scale.counted(v)) view.fills[iso] = pr.scale.shade(v);
        else if (frame >= hit + waveDelay(pr.wave.indexOf(iso), pr.wave.length)) { view.fills[iso] = C.amber; view.counted++; } else view.fills[iso] = DEEP;
      }
    } else {
      const from = base.start === 0 ? -100 : base.start;
      const fill = interpolate(frame, [from, from + 26], [0, 1], clamp);
      for (const iso of Object.keys(r.map)) {
        if (fill < pr.q.order[iso] * 0.9) continue;
        // On the rank card every country but the one named is held back, so it stands out.
        view.fills[iso] = base.kind === 'rank' && iso !== base.rank?.iso3 ? interpolateColors(0.62, [0, 1], [pr.q.colors[iso], C.land]) : pr.q.colors[iso];
      }
      if (base.kind === 'rank' && base.rank) {
        view.cam = [{ at: base.start === 0 ? -1000 : base.start, iso: base.rank.iso3 }];
        view.active = { iso: base.rank.iso3, at: base.start - 20 };
      }
    }
  }
  const before = p.teasers[i - 1]?.kind === 'promise' ? 0.5 : 0;
  if (t.kind === 'promise') view.dim = interpolate(frame, [t.start, t.start + 10], [0, 0.5], clamp);
  if (t.kind === 'rules') view.dim = interpolate(frame, [t.start, t.start + 8], [before, 0.62], clamp);
  return view;
}

// ---------- The cold open
const Open: React.FC<{ p: GameProps; t: Teaser; view: MapView }> = ({ p, t, view }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const text = t.headline.join('');
  const hit = t.cue.hit ?? t.cue.line ?? t.start;
  const r = t.round !== undefined ? p.rounds[t.round] : undefined;
  const shown = t.start === 0 ? 1 : fade(frame, t.start, 6);
  const panel: React.CSSProperties = { position: 'absolute', left: PX, top: PY, width: PW, fontFamily: FONT, color: C.pale, opacity: shown };
  return (
    <>
      {text && (
        <div style={{ position: 'absolute', left: 60, top: 14, width: 1800, height: 100, display: 'flex', alignItems: 'center', fontFamily: FONT, fontSize: fit(text, 76, 1800), fontWeight: 900, color: C.pale, whiteSpace: 'nowrap', letterSpacing: -1, opacity: shown }}>
          <span>{t.headline[0]}<span style={{ color: C.amber }}>{t.headline[1]}</span>{t.headline[2]}</span>
        </div>
      )}

      {t.kind === 'rank' && t.rank && (
        <div style={panel}>
          <PanelTitle>{t.rank.panelTitle}</PanelTitle>
          {t.rank.top === 5 ? [1, 2, 3, 4, 5].map((n) => {
            const at = hit - 14 + (n - 1) * 4;
            const s = frame >= at ? spring({ frame: frame - at, fps, config: { damping: 14 } }) : 0;
            return (
              <div key={n} style={{ height: 78, marginBottom: 10, borderRadius: 14, display: 'flex', alignItems: 'center', gap: 16, padding: '0 20px', boxSizing: 'border-box', background: CARD,
                border: `2px solid ${s > 0 ? C.amber : LINE}`, opacity: 0.45 + 0.55 * s }}>
                <div style={{ width: 60, fontSize: 32, fontWeight: 900 }}>#{n}</div>
                <div style={{ fontSize: 40, fontWeight: 900, color: C.amber, transform: `scale(${0.6 + 0.4 * s})`, opacity: s }}>?</div>
              </div>
            );
          }) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 10, marginBottom: 10 }}>
              {Array.from({ length: t.rank.top }, (_, k) => {
                const at = hit - 14 + (k * 20) / t.rank!.top;
                const s = frame >= at ? spring({ frame: frame - at, fps, config: { damping: 14 } }) : 0;
                return (
                  <div key={k} style={{ height: 78, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: CARD, border: `2px solid ${s > 0 ? C.amber : LINE}`, opacity: 0.45 + 0.55 * s }}>
                    <div style={{ fontSize: 22, fontWeight: 900 }}>#{k + 1}</div>
                    <div style={{ fontSize: 34, fontWeight: 900, color: C.amber, opacity: s }}>?</div>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ height: 96, borderRadius: 14, display: 'flex', alignItems: 'center', gap: 16, padding: '0 20px', boxSizing: 'border-box', background: 'rgba(217,236,247,0.16)', border: `3px solid ${C.pale}` }}>
            <div style={{ fontSize: 36, fontWeight: 900, flexShrink: 0 }}>#{t.rank.row.rank}</div>
            <Flag iso2={t.rank.row.iso2} height={40} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0, fontSize: fit(t.rank.row.name, 34, 290 - t.rank.row.display.length * 10), fontWeight: 900, whiteSpace: 'nowrap' }}>{t.rank.row.name}</div>
            <div style={{ fontSize: 28, fontWeight: 700, whiteSpace: 'nowrap' }}>{t.rank.row.display}</div>
          </div>
        </div>
      )}

      {t.kind === 'gap' && t.gap && (
        <div style={panel}>
          <PanelTitle>{t.gap.panelTitle}</PanelTitle>
          <Pop at={t.start + 4}><BigCard label="HIGHEST" value={t.gap.high} mystery /></Pop>
          <Pop at={t.start + 14}><BigCard label="LOWEST" value={t.gap.low} mystery /></Pop>
          <Pop at={hit} from="scale" style={{ marginTop: 8, borderRadius: 18, background: C.amber, color: C.bgDeep, textAlign: 'center', padding: '18px 0', fontSize: fit(t.gap.badge, 58, PW - 40), fontWeight: 900, whiteSpace: 'nowrap' }}>
            {t.gap.badge}
          </Pop>
        </div>
      )}

      {t.kind === 'count' && t.count && (
        <div style={panel}>
          <PanelTitle>{t.count.panelTitle}</PanelTitle>
          <div style={{ height: 300, marginBottom: 16, borderRadius: 18, background: CARD, border: `2px solid ${LINE}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: 4, color: C.muted }}>{t.count.year}</div>
            <div style={{ fontSize: 170, fontWeight: 900, color: C.amber, lineHeight: 1.05 }}>{frame >= hit ? countUp(frame, hit, t.count.n, COUNT_UP) : '–'}</div>
            <div style={{ fontSize: fit(`countries ${t.count.phrase}`, 36, PW - 50), fontWeight: 800, whiteSpace: 'nowrap' }}>{t.count.n === 1 ? 'country' : 'countries'} {t.count.phrase}</div>
          </div>
          <Pop at={hit + COUNT_UP + 4}><BigCard label="TODAY" value="How many?" mystery /></Pop>
        </div>
      )}

      {t.kind === 'promise' && t.promise && (
        <div style={{ position: 'absolute', left: 0, top: 250, width: LW, display: 'flex', justifyContent: 'center', gap: 70, fontFamily: FONT }}>
          {/* Every card keeps its place from the start, so the first ones don't slide when the next pops. */}
          {Array.from({ length: t.promise.cards }, (_, k) => (
            <div key={k} style={{ width: 400, height: 400 }}>
              <Pop at={(t.cue.cards ?? hit) + k * 5} from="scale" style={{ width: 400, height: 400, borderRadius: 30, boxSizing: 'border-box', background: 'rgba(10,29,43,0.9)', border: `5px dashed ${C.amber}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ fontSize: 230, fontWeight: 900, color: C.amber, lineHeight: 1 }}>?</div>
                {t.promise!.lines.map((line) => <div key={line} style={{ fontSize: fit(line, 28, 350, 2), fontWeight: 800, letterSpacing: 2, color: C.pale, marginTop: 6, whiteSpace: 'nowrap', opacity: fade(frame, hit - 4, 6) }}>{line}</div>)}
              </Pop>
            </div>
          ))}
        </div>
      )}

      {t.kind === 'rules' && t.rules && (
        <div style={{ position: 'absolute', left: 0, top: 300, width: LW, display: 'flex', justifyContent: 'center', gap: 44, fontFamily: FONT }}>
          {t.rules.map((c, k) => (
            <div key={c.small} style={{ width: 470, height: 360 }}>
              <Pop at={t.cue[`rule.${k}`] ?? t.start + k * 12} from="scale" style={{ width: 470, height: 360, borderRadius: 30, boxSizing: 'border-box', background: 'rgba(10,29,43,0.92)', border: `4px solid ${C.amber}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ fontSize: 170, fontWeight: 900, color: C.amber, lineHeight: 1 }}>{c.big}</div>
                <div style={{ fontSize: 40, fontWeight: 900, letterSpacing: 3, color: C.pale, marginTop: 16, whiteSpace: 'nowrap' }}>{c.small}</div>
              </Pop>
            </div>
          ))}
        </div>
      )}

      {r && (t.kind === 'rank' || t.kind === 'gap' || t.kind === 'intro') && <Key from={t.start === 0 ? -100 : t.start}><LessMore unit={r.unit} /></Key>}
      {r?.count && t.kind === 'count' && <Key from={t.start === 0 ? -100 : t.start}><Swatch /><span>{r.count.short}</span><span style={{ opacity: 0.7, fontWeight: 500 }}>{view.counted} of {r.count.of} countries</span></Key>}
    </>
  );
};

// ---------- One round
const RoundScene: React.FC<{ r: GameRound; total: number; timer: number; view: MapView; doneAt: number[] }> = ({ r, total, timer, view, doneAt }) => {
  const frame = useCurrentFrame();
  const q = r.cue;
  const at = (k: string) => q[k] ?? Infinity;
  const one = r.top[0];
  const revealed = frame >= at('reveal');
  const state = (i: number) => (!revealed ? 'open' : i === r.answer ? 'right' : 'wrong');
  const ask = span(r, 'ask')!;
  const ladder = span(r, 'ladder');
  const own = span(r, 'own');
  const compare = span(r, 'compare');
  const extremes = span(r, 'extremes');
  const count = r.count;
  const today = count ? count.counts[count.counts.length - 1] : 0;
  const timerBox = (label: string, top = 26) => <div style={{ marginTop: top, height: 190 }}><Timer from={at('timer')} frames={timer} label={label} /></div>;
  const bigOptions = (
    <div style={{ display: 'flex', gap: 12, height: 124 }}>
      {r.options.map((o, i) => (
        <div key={o.letter} style={{ flex: 1, display: 'flex', minWidth: 0 }}>
          <Pop at={at(`opt.${i}`)} from="below" style={{ flex: 1, display: 'flex', minWidth: 0 }}>
            <Option letter={o.letter} label={o.label} big state={state(i)} room={(PW - (r.options.length - 1) * 12) / r.options.length - 86} />
          </Pop>
        </div>
      ))}
    </div>
  );
  // The answer card over the map: "#1 Luxembourg, $137,782".
  const answerCard = (from: number, to: number) => frame >= from && frame < to && (
    <Pop at={from} from="below" style={{ position: 'absolute', left: LM.x + 24, top: LM.y + 24, background: 'rgba(10,29,43,0.92)', border: `3px solid ${C.amber}`, borderRadius: 18, padding: '16px 28px',
      fontFamily: FONT, color: C.pale, display: 'flex', alignItems: 'center', gap: 20, boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }}>
      <Flag iso2={one.iso2} height={64} />
      <div>
        <div style={{ fontSize: fit(`#1 ${one.name}`, 54, 700), fontWeight: 900, color: C.amber, lineHeight: 1.05, whiteSpace: 'nowrap' }}>#1 {one.name}</div>
        <div style={{ fontSize: 34, fontWeight: 800, whiteSpace: 'nowrap' }}>{one.display} <span style={{ fontSize: 24, fontWeight: 700, color: C.muted }}>{r.valueUnit}</span></div>
      </div>
    </Pop>
  );
  const afterTop = own?.from ?? compare?.from ?? r.end;

  return (
    <>
      <Header tag={`ROUND ${r.n} OF ${total} · ${r.tag}`} title={r.title} year={r.yearText} from={r.start + 16} />
      <Rounds total={total} current={r.n} doneAt={doneAt} />
      <Key from={r.start + 20}>
        {r.kind === 'then_now' && count && frame < (r.phases[1]?.from ?? Infinity) ? <><Swatch /><span>{count.short}</span><span style={{ width: 8 }} /><LessMore unit={r.unit} /></>
          : r.kind === 'how_many' && count && revealed ? <><Swatch /><span>{count.short}</span><span style={{ width: 8 }} /><LessMore unit={r.unit} /></>
            : <LessMore unit={r.unit} />}
      </Key>

      {/* The question, the choices and the timer. */}
      <Panel from={r.start + 14} to={ask.to}>
        {r.kind === 'pick' && (
          <>
            <div style={{ fontSize: 40, fontWeight: 900, lineHeight: 1.12, height: 100 }}>{r.question}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, height: 318 }}>
              {r.options.map((o, i) => (
                <Pop key={o.letter} at={at(`opt.${i}`)}>
                  <Option letter={o.letter} label={o.label} iso2={o.iso2} state={state(i)} />
                </Pop>
              ))}
            </div>
            {timerBox('A, B or C?')}
          </>
        )}
        {r.kind === 'then_now' && count && (
          <>
            <PanelTitle>{`COUNTRIES ${count.short.toUpperCase()}`}</PanelTitle>
            <div style={{ height: count.years.length * 59 }}>
              {count.years.map((y, i) => {
                const last = i === count.years.length - 1;
                const known = i === 0 ? frame >= at('then.count') + COUNT_UP : view.yearIdx >= i;
                return (
                  <div key={y} style={{ height: 52, marginBottom: 7, borderRadius: 12, display: 'flex', alignItems: 'center', padding: '0 20px', boxSizing: 'border-box', background: last && known ? C.amber : CARD,
                    border: `2px solid ${i === view.yearIdx && frame >= at('then.count') ? C.amber : LINE}`, color: last && known ? C.bgDeep : C.pale }}>
                    <div style={{ flex: 1, fontSize: 30, fontWeight: 800 }}>{last ? 'Today' : y}</div>
                    <div style={{ fontSize: 34, fontWeight: 900, color: last && known ? C.bgDeep : known ? C.amber : C.muted }}>{known ? count.counts[i] : '?'}</div>
                  </div>
                );
              })}
            </div>
            {frame >= at('opts') - 4 && (
              <div style={{ opacity: fade(frame, at('opts') - 4, 6) }}>
                <div style={{ fontSize: 38, fontWeight: 900, lineHeight: 1.12, margin: '10px 0 14px' }}>{r.question}</div>
                {bigOptions}
                {timerBox('A, B or C?', 20)}
              </div>
            )}
          </>
        )}
        {r.kind === 'how_many' && count && (
          <>
            <div style={{ fontSize: 40, fontWeight: 900, lineHeight: 1.12, minHeight: 100, marginBottom: 14 }}>{r.question}</div>
            {bigOptions}
            {!revealed ? timerBox('A, B or C?') : (
              <Pop at={at('reveal')} from="below" style={{ marginTop: 26, height: 150, borderRadius: 18, background: 'rgba(10,29,43,0.92)', border: `3px solid ${C.amber}`, display: 'flex', alignItems: 'center', gap: 20, padding: '0 24px', boxSizing: 'border-box' }}>
                <div style={{ fontSize: 96, fontWeight: 900, color: C.amber, minWidth: 110, textAlign: 'right', lineHeight: 1 }}>{countUp(frame, at('reveal'), today, COUNT_UP)}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 30, fontWeight: 800, whiteSpace: 'nowrap' }}>of {count.of} countries</div>
                  <div style={{ fontSize: fit(count.short, 30, 330), fontWeight: 800, color: C.blue, whiteSpace: 'nowrap' }}>{count.short}</div>
                </div>
              </Pop>
            )}
          </>
        )}
        {r.kind === 'higher_lower' && r.duel && (
          <>
            <div style={{ fontSize: 38, fontWeight: 900, lineHeight: 1.12, minHeight: 92 }}>{r.question}</div>
            {[{ row: r.duel.ref, at: at('duel.ref'), value: r.duel.ref.display, hot: false }, { row: r.duel.target, at: at('duel.target'), value: revealed ? r.duel.target.display : '?', hot: revealed }].map((d) => (
              <Pop key={d.row.iso3} at={d.at} style={{ height: 88, marginBottom: 12, borderRadius: 16, display: 'flex', alignItems: 'center', gap: 16, padding: '0 20px', boxSizing: 'border-box',
                background: d.hot ? C.amber : CARD, border: `3px solid ${d.hot ? C.amber : LINE}`, color: d.hot ? C.bgDeep : C.pale }}>
                <Flag iso2={d.row.iso2} height={40} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0, fontSize: fit(d.row.name, 36, 340 - d.value.length * 16), fontWeight: 900, whiteSpace: 'nowrap' }}>{d.row.name}</div>
                <div style={{ fontSize: 36, fontWeight: 900, whiteSpace: 'nowrap', color: d.hot ? C.bgDeep : d.value === '?' ? C.amber : C.pale }}>{d.value}</div>
              </Pop>
            ))}
            <div style={{ marginTop: 2 }}>{bigOptions}</div>
            {timerBox('Higher or lower?', 20)}
          </>
        )}
      </Panel>

      {/* Then and now: the year, big, on the map, and how many countries are counted. */}
      {r.kind === 'then_now' && count && frame >= r.start + 12 && frame < ask.to && (
        <div style={{ position: 'absolute', left: LM.x + 26, top: LM.y + 20, fontFamily: FONT, opacity: fade(frame, r.start + 12), display: 'flex', alignItems: 'center', gap: 22 }}>
          <div style={{ fontSize: 112, fontWeight: 900, color: C.pale, lineHeight: 1, textShadow: '0 6px 30px rgba(10,29,43,0.95)' }}>{count.years[view.yearIdx]}</div>
          {frame >= at('then.count') && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, background: 'rgba(10,29,43,0.92)', border: `3px solid ${C.amber}`, borderRadius: 16, padding: '6px 22px' }}>
              <div style={{ fontSize: 64, fontWeight: 900, color: C.amber, minWidth: 76, textAlign: 'right' }}>{view.counted}</div>
              <div style={{ fontSize: fit(`countries ${count.short}`, 32, 620), fontWeight: 800, color: C.pale, whiteSpace: 'nowrap' }}>{view.counted === 1 ? 'country' : 'countries'} {count.short}</div>
            </div>
          )}
        </div>
      )}
      {r.kind === 'pick' ? answerCard(at('reveal'), afterTop) : r.kind !== 'then_now' && answerCard(at('ladder.1') - 6, afterTop)}

      {ladder && (
        <Panel from={ladder.from} to={ladder.to}>
          <PanelTitle>{`TOP 5 OF ${r.countries} COUNTRIES`}</PanelTitle>
          {r.top.map((row) => (
            <RankRow key={row.rank} rank={row.rank} iso2={row.iso2} name={row.name} display={row.display} hot={row.rank === 1}
              at={row.rank === 1 && r.kind === 'pick' ? ladder.from : at(`ladder.${row.rank}`)} />
          ))}
        </Panel>
      )}

      {extremes && r.extremes && (
        <Panel from={extremes.from} to={extremes.to}>
          <PanelTitle>{`TODAY · ${r.countries} COUNTRIES`}</PanelTitle>
          <Pop at={at('ext.high') - 4}><BigCard label={`HIGHEST · ${r.extremes.high.name}`} value={r.extremes.high.display} iso2={r.extremes.high.iso2} hot /></Pop>
          {r.extremes.low && <Pop at={at('ext.low') - 4}><BigCard label={`LOWEST · ${r.extremes.low.name}`} value={r.extremes.low.display} iso2={r.extremes.low.iso2} /></Pop>}
        </Panel>
      )}

      {own && (
        <Panel from={own.from} to={own.to}>
          <PanelTitle>{r.ownTitle}</PanelTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14 }}>
            {ownChips(r).map(({ chip, at: popAt }) => (
              <Pop key={chip.iso3} at={popAt} from="below">
                <Chip iso2={chip.iso2} name={chip.name} main={chip.main} sub={chip.sub} />
              </Pop>
            ))}
          </div>
        </Panel>
      )}

      {compare && r.bars && (
        <Panel from={compare.from} to={compare.to}>
          <PanelTitle>HOW FAR AHEAD IS #1?</PanelTitle>
          {r.bars.map((b, i) => {
            const barAt = i === 0 ? compare.from : i === r.bars!.length - 1 ? at('compare.low') : at('compare.mid');
            const grow = interpolate(frame, [barAt, barAt + 14], [0, 1], clamp);
            return (
              <Pop key={b.label} at={barAt} from="below" style={{ marginBottom: 40 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  {b.iso2 && <Flag iso2={b.iso2} height={34} style={{ flexShrink: 0 }} />}
                  <div style={{ flex: 1, minWidth: 0, fontSize: fit(b.label, 34, (b.iso2 ? 480 : 540) - b.display.length * 22), fontWeight: 800, whiteSpace: 'nowrap' }}>{b.label}</div>
                  <div style={{ fontSize: 36, fontWeight: 900, whiteSpace: 'nowrap' }}>{b.display}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, height: 60 }}>
                  <div style={{ width: Math.max(6, PW * b.share * grow), height: 60, borderRadius: 8, background: b.amber ? C.amber : C.blue, flexShrink: 0 }} />
                  {b.note && <div style={{ fontSize: fit(b.note, 40, PW - 30 - PW * b.share), fontWeight: 900, color: C.amber, whiteSpace: 'nowrap' }}>{b.note}</div>}
                </div>
              </Pop>
            );
          })}
        </Panel>
      )}

      <PlusOne at={at('point')} lines={r.pointText} />
      <Stinger at={r.start} big={r.n === total && total > 1 ? 'LAST ROUND' : `ROUND ${r.n}`} small={r.tag} />
    </>
  );
};

// ---------- The ending: the last reveal, then the score
const Ending: React.FC<{ p: GameProps }> = ({ p }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const e = p.ending;
  const at = (k: string) => e.cue[k] ?? Infinity;
  const total = p.rounds.length;
  const scoreFrom = at('score') - 8;
  const k = e.champions.length;
  const cardW = k === 1 ? 760 : k === 2 ? 620 : 540;
  return (
    <AbsoluteFill style={{ fontFamily: FONT, color: C.pale, alignItems: 'center', opacity: fade(frame, e.start, 8) }}>
      {frame < scoreFrom ? (
        k ? (
          <>
            <div style={{ marginTop: 50, fontSize: 30, fontWeight: 800, letterSpacing: 5, color: C.blue }}>THE LAST REVEAL</div>
            <div style={{ fontSize: 84, fontWeight: 900, lineHeight: 1.05, marginTop: 8, whiteSpace: 'nowrap' }}>TOP 10 ON <span style={{ color: C.amber }}>{e.times === total ? `ALL ${total}` : `${e.times} OF ${total}`}</span> MAPS</div>
            <div style={{ display: 'flex', gap: k === 3 ? 40 : 70, marginTop: 36 }}>
              {e.champions.map((c, i) => {
                const flipAt = at(`champ.${i}`);
                const shown = frame >= flipAt;
                const s = shown ? spring({ frame: frame - flipAt, fps, config: { damping: 13 } }) : 1;
                const rowH = Math.min(30, 270 / Math.max(1, c.maps.length));
                return (
                  <Pop key={c.iso3} at={Math.min(at('final.cards'), at('final.hit')) + i * 5} from="scale" style={{ width: cardW, height: 620 }}>
                    <div style={{ width: cardW, height: 620, borderRadius: 30, boxSizing: 'border-box', background: 'rgba(10,29,43,0.94)', border: shown ? `5px solid ${C.amber}` : `5px dashed ${C.amber}`,
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', transform: `scale(${shown ? 1.12 - 0.12 * s : 1})`, boxShadow: shown ? '0 0 70px rgba(240,176,74,0.35)' : 'none' }}>
                      {shown ? (
                        <>
                          <Flag iso2={c.iso2} height={120} />
                          <div style={{ fontSize: fit(c.name, 68, cardW - 70), fontWeight: 900, color: C.amber, marginTop: 14, lineHeight: 1.1, whiteSpace: 'nowrap' }}>{c.name}</div>
                          <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: 3, color: C.muted, margin: '6px 0 12px' }}>TOP 10 ON {c.maps.length === total ? `ALL ${total}` : `${c.maps.length} OF ${total}`} MAPS</div>
                          {c.maps.map((m) => (
                            <div key={m.title} style={{ height: rowH, lineHeight: `${rowH}px`, fontSize: Math.min(rowH - 4, fit(`#${m.rank} ${m.title}`, 25, cardW - 70)), fontWeight: 700, whiteSpace: 'nowrap' }}>
                              <span style={{ color: C.amber, fontWeight: 900 }}>#{m.rank}</span> {m.title}
                            </div>
                          ))}
                        </>
                      ) : <div style={{ fontSize: 290, fontWeight: 900, color: C.amber, lineHeight: 1 }}>?</div>}
                    </div>
                  </Pop>
                );
              })}
            </div>
          </>
        ) : (
          <div style={{ marginTop: 330, fontSize: 130, fontWeight: 900, lineHeight: 1, whiteSpace: 'nowrap' }}>THAT’S ALL <span style={{ color: C.amber }}>{total}</span> ROUNDS</div>
        )
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: fade(frame, scoreFrom, 8) }}>
          <div style={{ marginTop: 110, fontSize: 130, fontWeight: 900, lineHeight: 1 }}>YOUR SCORE?</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 40, marginTop: 50 }}>
            <div style={{ width: 290, height: 290, borderRadius: 44, boxSizing: 'border-box', border: `8px dashed ${C.amber}`, background: 'rgba(10,29,43,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 220, fontWeight: 900, color: C.amber }}>?</div>
            <div style={{ fontSize: 150, fontWeight: 800, color: C.muted, whiteSpace: 'nowrap' }}>out of</div>
            <div style={{ fontSize: 290, fontWeight: 900, color: C.pale, lineHeight: 1 }}>{total}</div>
          </div>
          <Pop at={at('score.ask')} from="below" style={{ marginTop: 44, fontSize: 72, fontWeight: 900, color: C.pale }}>Comment your score <span style={{ color: C.amber }}>↓</span></Pop>
        </div>
      )}
    </AbsoluteFill>
  );
};

export const Game: React.FC<GameProps> = (p) => {
  const [handle] = useState(() => delayRender('fonts'));
  useEffect(() => { document.fonts.ready.then(() => continueRender(handle)); }, [handle]);
  const frame = useCurrentFrame();
  const total = p.rounds.length;
  const prep = useMemo<Prep[]>(() => p.rounds.map((r) => ({
    q: quantiles(r.map),
    scale: r.count ? countScale(r.count) : undefined,
    wave: r.count ? waveOrder(r.count.maps[0], r.count) : [],
  })), [p.rounds]);
  const doneAt = useMemo(() => p.rounds.map((r) => r.cue.point ?? r.cue.reveal ?? r.end), [p.rounds]);

  const round = p.rounds.find((r) => frame >= r.start && frame < r.end);
  const ending = !round && frame >= p.ending.start;
  let teaser: Teaser | undefined;
  if (!round && !ending) for (const t of p.teasers) if (t.start <= frame) teaser = t;

  let view = emptyView();
  if (round) view = roundView(round, prep[round.n - 1], frame);
  else if (teaser) view = teaserView(p, teaser, prep, frame);
  else if (ending && total) {
    view.fills = prep[total - 1].q.colors;
    view.dim = interpolate(frame, [p.ending.start, p.ending.start + 8], [0, 0.7], clamp);
  }
  const source = round?.sourceLine ?? (teaser?.round !== undefined ? p.rounds[teaser.round]?.sourceLine : '') ?? '';

  return (
    <AbsoluteFill style={{ background: C.bgDeep }}>
      <Bg />
      <GameMap fills={view.fills} cam={view.cam} outlines={view.outlines} active={view.active} />
      {/* A veil over the whole frame while a full-screen card is up. */}
      {view.dim > 0 && <AbsoluteFill style={{ background: `rgba(10,29,43,${view.dim})` }} />}
      {teaser && <Open p={p} t={teaser} view={view} />}
      {round && <RoundScene r={round} total={total} timer={p.timer} view={view} doneAt={doneAt} />}
      {ending && <Ending p={p} />}
      <Captions lines={p.lines} />
      {/* Where the viewer is in the video: a thin bar across the top with every round's start marked. */}
      <div style={{ position: 'absolute', left: 0, top: 0, width: LW, height: 8, background: 'rgba(217,236,247,0.1)' }}>
        <div style={{ width: (LW * frame) / p.durationInFrames, height: 8, background: C.amber }} />
        {[...p.rounds.map((r) => r.start), p.ending.start].map((f) => <div key={f} style={{ position: 'absolute', left: (LW * f) / p.durationInFrames - 2, top: 0, width: 4, height: 8, background: C.bgDeep }} />)}
      </div>
      <div style={{ position: 'absolute', left: 60, bottom: 14, fontFamily: FONT, fontSize: 20, fontWeight: 500, color: C.muted, whiteSpace: 'nowrap' }}>{source}</div>
      <div style={{ position: 'absolute', right: 60, bottom: 14, fontFamily: FONT, fontSize: 22, fontWeight: 700, color: C.blue }}>{p.handle}</div>
    </AbsoluteFill>
  );
};
