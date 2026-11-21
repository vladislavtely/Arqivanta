import type { FieldNote } from '../notes/types.ts';
import { formatDate } from './date.ts';

export function formatNote(note: FieldNote): string {
  return `${formatDate(note.observedAt)} · ${note.location} · ${note.observation}`;
}
