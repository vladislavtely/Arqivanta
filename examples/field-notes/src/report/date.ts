export function formatDate(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
