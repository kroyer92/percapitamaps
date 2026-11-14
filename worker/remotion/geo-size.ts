// Countries that cross the 180° meridian (Russia's Chukotka tip, Fiji, Kiribati, New Zealand's
// Chatham Islands) are cut in two by a world projection: one piece is drawn at the far right edge
// of the map and the other at the far left. Their projected bounds then span the whole world, so
// a shape fitted to them comes out as a thin sliver with a stray dot (the 14 Nov 2026 wheat Guess
// Short drew Russia like that). Measuring and drawing a single country with a copy of the
// projection turned to face that country keeps it in one piece.
import { geoCentroid, geoEqualEarth, geoPath, type GeoProjection } from 'd3-geo';

// The same projection at the same scale, turned so the shape's centre is in the middle.
export function facing(projection: GeoProjection, shape: any): GeoProjection {
  const [lon] = geoCentroid(shape);
  return geoEqualEarth().scale(projection.scale()).translate(projection.translate()).rotate([-lon, 0]);
}

// Width and height of a shape as the projection draws it, without the 180° split.
export function shapeSize(projection: GeoProjection, shape: any): [number, number] {
  const [[x0, y0], [x1, y1]] = geoPath(facing(projection, shape)).bounds(shape);
  return [x1 - x0, y1 - y0];
}
