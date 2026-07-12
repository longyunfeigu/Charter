/** Prefixed unique id, safe in both Node and browser contexts. */
export function newId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}
