/**
 * Content keys for mesh payloads. Two 32-bit lanes over the exact float64 bit pattern of every
 * value (plus the lengths in the key), so equal arrays always share a key and any changed value,
 * including -0 vs 0, produces a different one.
 */

const scratchF64 = new Float64Array(1);
const scratchU32 = new Uint32Array(scratchF64.buffer);

type HashState = { a: number; b: number };

function newHashState(): HashState {
  return { a: 0x811c9dc5, b: 0x9747b28c };
}

function mixWord(state: HashState, word: number) {
  state.a = Math.imul(state.a ^ word, 0x01000193);
  state.b = Math.imul(state.b ^ word, 0x5bd1e995);
  state.b ^= state.b >>> 15;
}

function mixNumbers(state: HashState, values: ArrayLike<number>) {
  mixWord(state, values.length);
  for (let index = 0; index < values.length; index += 1) {
    scratchF64[0] = values[index];
    mixWord(state, scratchU32[0]);
    mixWord(state, scratchU32[1]);
  }
}

function digest(state: HashState) {
  return `${(state.a >>> 0).toString(16).padStart(8, "0")}${(state.b >>> 0).toString(16).padStart(8, "0")}`;
}

export type MeshGeometryPayload = {
  positions: ArrayLike<number>;
  indices?: ArrayLike<number>;
  normals?: ArrayLike<number>;
};

export function meshGeometryKey(mesh: MeshGeometryPayload): string {
  const state = newHashState();
  mixNumbers(state, mesh.positions);
  mixNumbers(state, mesh.indices ?? []);
  mixNumbers(state, mesh.normals ?? []);
  return `g:${mesh.positions.length}.${mesh.indices?.length ?? 0}.${mesh.normals?.length ?? 0}:${digest(state)}`;
}

export function textContentKey(text: string): string {
  const state = newHashState();
  mixWord(state, text.length);
  for (let index = 0; index < text.length; index += 1) {
    mixWord(state, text.charCodeAt(index));
  }
  return `s:${text.length}:${digest(state)}`;
}

/** Cheap staleness check for memoized keys: length plus a spread of sampled values. */
export function sampledArraySignature(values: ArrayLike<number>, samples = 24): string {
  if (values.length === 0) return "0";
  const step = Math.max(1, Math.floor(values.length / samples));
  const parts: number[] = [values.length];
  for (let index = 0; index < values.length; index += step) parts.push(values[index]);
  parts.push(values[values.length - 1]);
  return parts.join(",");
}
