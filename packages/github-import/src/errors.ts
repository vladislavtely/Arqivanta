export type GitHubImportErrorCode =
  | 'invalid-url'
  | 'not-found'
  | 'rate-limit'
  | 'too-large'
  | 'invalid-archive'
  | 'unavailable'
  | 'canceled';

export class GitHubImportError extends Error {
  readonly code: GitHubImportErrorCode;

  constructor(code: GitHubImportErrorCode, message: string) {
    super(message);
    this.name = 'GitHubImportError';
    this.code = code;
  }
}
