// Pure link geometry for the TT&C panel: where a ground station sees a satellite,
// and whether two satellites see each other past the Earth.

import { Cartesian3, Ellipsoid, Math as CesiumMath } from "@cesium/core";

const SPEED_OF_LIGHT_KM_S = 299792.458;
/** A ground segment's encode/route/decode budget, on top of the light time. */
const PROCESSING_MS = 120;

export interface GroundLinkStats {
  elevationDeg: number;
  distanceKm: number;
  latencyMs: number;
  visible: boolean;
}

export interface InterSatelliteLinkStats {
  distanceKm: number;
  latencyMs: number;
  visible: boolean;
}

export function linkLatencyMs(distanceKm: number): number {
  return (distanceKm / SPEED_OF_LIGHT_KM_S) * 1000 + PROCESSING_MS;
}

export function groundLinkStats(satellite: Cartesian3, station: Cartesian3, ellipsoid: Ellipsoid = Ellipsoid.WGS84): GroundLinkStats {
  const toSatellite = Cartesian3.subtract(satellite, station, new Cartesian3());
  const distanceKm = Cartesian3.magnitude(toSatellite) / 1000;
  const direction = Cartesian3.normalize(toSatellite, new Cartesian3());
  const up = ellipsoid.geodeticSurfaceNormal(station, new Cartesian3());
  const sinElevation = Math.min(1, Math.max(-1, Cartesian3.dot(direction, up)));
  const elevationDeg = CesiumMath.toDegrees(Math.asin(sinElevation));
  return { elevationDeg, distanceKm, latencyMs: linkLatencyMs(distanceKm), visible: elevationDeg > 0 };
}

export function interSatelliteStats(a: Cartesian3, b: Cartesian3, ellipsoid: Ellipsoid = Ellipsoid.WGS84): InterSatelliteLinkStats {
  const distanceKm = Cartesian3.distance(a, b) / 1000;
  return { distanceKm, latencyMs: linkLatencyMs(distanceKm), visible: !segmentHitsEllipsoid(a, b, ellipsoid) };
}

/**
 * Scaled to a unit sphere, the segment test is exact for an ellipsoid: the ellipsoid's
 * radii are those of WGS84, and both endpoints are outside it.
 */
export function segmentHitsEllipsoid(a: Cartesian3, b: Cartesian3, ellipsoid: Ellipsoid = Ellipsoid.WGS84): boolean {
  const radii = ellipsoid.radii;
  const scale = new Cartesian3(1 / radii.x, 1 / radii.y, 1 / radii.z);
  const start = Cartesian3.multiplyComponents(a, scale, new Cartesian3());
  const end = Cartesian3.multiplyComponents(b, scale, new Cartesian3());
  const direction = Cartesian3.subtract(end, start, new Cartesian3());
  const quadratic = Cartesian3.dot(direction, direction);
  if (!(quadratic > 0)) {
    return false;
  }
  const linear = 2 * Cartesian3.dot(start, direction);
  const constant = Cartesian3.dot(start, start) - 1;
  const discriminant = linear * linear - 4 * quadratic * constant;
  if (discriminant <= 0) {
    return false;
  }
  const root = Math.sqrt(discriminant);
  const enter = (-linear - root) / (2 * quadratic);
  const leave = (-linear + root) / (2 * quadratic);
  return (enter > 0 && enter < 1) || (leave > 0 && leave < 1);
}
