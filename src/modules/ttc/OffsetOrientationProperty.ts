import { Event, JulianDate, Quaternion } from "@cesium/core";
import type { VelocityOrientationProperty } from "@cesium/engine";

/**
 * The velocity orientation with the TT&C panel's body-frame rotation composed onto it.
 * An entity property, not a per-frame callback: Cesium evaluates it during the entity
 * update, so it survives trajectory refills and LOD copies without extra bookkeeping.
 */
export class OffsetOrientationProperty {
  readonly isConstant = false;

  readonly definitionChanged = new Event();

  readonly #base: VelocityOrientationProperty;

  readonly #offset: () => Quaternion;

  constructor(base: VelocityOrientationProperty, offset: () => Quaternion) {
    this.#base = base;
    this.#offset = offset;
  }

  getValue(time?: JulianDate, result?: Quaternion): Quaternion | undefined {
    const quaternion = this.#base.getValue(time, result);
    // Undefined at a sample window's edge, where Cesium holds no velocity.
    if (!quaternion) {
      return undefined;
    }
    // Right multiplication applies the offset in the model's own frame.
    return Quaternion.multiply(quaternion, this.#offset(), quaternion);
  }

  equals(other: unknown): boolean {
    return this === other;
  }
}
