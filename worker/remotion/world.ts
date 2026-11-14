// The country shapes every map draws. They are the world-atlas 50m Natural Earth borders, except
// that India, Pakistan and China follow India's official map: all of Jammu & Kashmir and Ladakh
// (including the Pakistan- and China-administered parts and the Siachen Glacier) is drawn as
// India. Most of the audience is Indian and the standard map kept getting "wrong map of India"
// comments. See scripts/build-india-view.mjs for how the shapes are made.
import { feature } from 'topojson-client';
import world from 'world-atlas/countries-50m.json';
import indiaView from './data/india-view-50m.json';

const view = indiaView as unknown as { replace: Record<string, any>; drop: string[] };

export function worldFeatures(): any[] {
  return (feature(world as any, (world as any).objects.countries) as any).features
    .filter((f: any) => !view.drop.includes(f.properties?.name))
    .map((f: any) => (view.replace[f.id] ? { ...f, geometry: view.replace[f.id] } : f));
}
