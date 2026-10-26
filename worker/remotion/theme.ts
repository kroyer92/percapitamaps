// Channel look, matching the banner and avatar: navy, pale blue, amber.
export const C = {
  bg: '#0f2a3d',
  bgDeep: '#0a1d2b',
  grid: 'rgba(111,179,224,0.07)',
  pale: '#d9ecf7',
  blue: '#6fb3e0',
  amber: '#f0b04a',
  muted: '#8fb0c4',
  land: '#1d4058',
  border: '#0f2a3d',
  ramp: ['#1f4c69', '#2c6788', '#4d8aa3', '#8fae95', '#c9b26a', '#f0b04a'],
  // The map's measure scale: blue only, from dark to light, wide enough to read on a phone.
  blues: ['#17405c', '#1f5a80', '#2f78a6', '#4f98c6', '#7db8de', '#b5daf2'],
};
export const W = 1080;
export const H = 1920;
// Safe zone: everything that matters stays between y 280 and 1500, clear of the Shorts UI.
export const SAFE = { top: 300, bottom: 1490, left: 60, right: 1020 };
export const ZONE = { kicker: 300, headline: 360, visualTop: 600, visualBottom: 1270, captions: 1300, source: 1440 };
// The world map fills the phone: it is centred here and drawn larger than the screen is wide.
export const MAP = { centreY: 1040, home: 1.6 };
export const FONT = "'Inter', system-ui, sans-serif";
