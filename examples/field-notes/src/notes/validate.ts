import type { FieldNote } from './types.ts';

function isFieldNote(value: unknown): value is FieldNote {
  if (!value || typeof value !== 'object') return false;
  const note = value as Partial<FieldNote>;
  return (
    typeof note.location === 'string' &&
    typeof note.observation === 'string' &&
    typeof note.observedAt === 'string' &&
    Number.isFinite(Date.parse(note.observedAt))
  );
}

export function readNotes(input: unknown): FieldNote[] {
  if (!Array.isArray(input)) return [];
  return input.filter(isFieldNote);
}
