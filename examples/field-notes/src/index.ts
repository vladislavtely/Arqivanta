import { formatNote } from './report/format.ts';
import { newestFirst } from './notes/timeline.ts';
import { readNotes } from './notes/validate.ts';

export function createFieldReport(input: unknown) {
  return newestFirst(readNotes(input)).map(formatNote).join('\n');
}

export type { FieldNote } from './notes/types.ts';
