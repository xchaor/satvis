// The TT&C scene state the Cesium properties read every frame. Plain maps, not Pinia:
// `getValue` runs inside Cesium's render loop, where a reactive read would be wasted.

import { Cartesian3, HeadingPitchRoll, Math as CesiumMath, Quaternion } from "@cesium/core";

/** Degrees, in the satellite's body frame: x is velocity, y is lateral, z is zenith. */
export interface AttitudeAngles {
  /** About the velocity axis. */
  roll: number;
  /** About the lateral axis. */
  pitch: number;
  /** About the zenith axis. */
  yaw: number;
}

const attitudes = new Map<string, AttitudeAngles>();

const attitudeScratch = new Quaternion();

/** The body-frame rotation the TT&C panel applies, identity when it does not control the satellite. */
export function attitudeQuaternionOf(name: string): Quaternion {
  const angles = attitudes.get(name);
  if (!angles || (angles.roll === 0 && angles.pitch === 0 && angles.yaw === 0)) {
    return Quaternion.IDENTITY;
  }
  // Cesium's HPR turns about -Z (heading), -Y (pitch) and +X (roll).
  return Quaternion.fromHeadingPitchRoll(
    new HeadingPitchRoll(CesiumMath.toRadians(-angles.yaw), CesiumMath.toRadians(-angles.pitch), CesiumMath.toRadians(angles.roll)),
    attitudeScratch,
  );
}

export function setAttitudeAngles(name: string, angles: AttitudeAngles): void {
  attitudes.set(name, { ...angles });
}

export function clearAttitudeAngles(name: string): void {
  attitudes.delete(name);
}

/** Degrees from deployed (0) to stowed (90), per satellite: a physical configuration, so it outlives a lock. */
const panelAngles = new Map<string, number>();

export function panelAngleOf(name: string): number {
  return panelAngles.get(name) ?? 0;
}

export function setPanelAngle(name: string, degrees: number): void {
  panelAngles.set(name, Math.min(90, Math.max(0, degrees)));
}

const panelScratch = new Quaternion();

/**
 * The hinge rotation for a demo model's panel node, in the node's own frame. The hinge
 * runs along the velocity axis (+Z in the source glTF); the port panel (+X) folds toward
 * nadir with a negative angle, the starboard one with a positive angle.
 */
export function panelNodeRotation(name: string, side: 1 | -1): Quaternion {
  return Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, -side * CesiumMath.toRadians(panelAngleOf(name)), panelScratch);
}

/** A model file chosen for a satellite, replacing the one a manifest gave it. */
export interface ModelOverride {
  url: string;
  label: string;
  /** Only the demo model keeps its solar panels as separate nodes, so only it can hinge. */
  panels?: boolean;
}

const modelOverrides = new Map<string, ModelOverride>();

export function modelOverrideOf(name: string): ModelOverride | undefined {
  return modelOverrides.get(name);
}

export function setModelOverride(name: string, override: ModelOverride): void {
  modelOverrides.set(name, override);
}

export function clearModelOverride(name: string): void {
  modelOverrides.delete(name);
}
