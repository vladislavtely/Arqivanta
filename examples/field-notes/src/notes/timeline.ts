import type { FieldNote } from './types.ts';

export function newestFirst(notes: FieldNote[]): FieldNote[] {
  return [...notes].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
}
