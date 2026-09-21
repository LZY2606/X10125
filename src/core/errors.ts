export class LedgerError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code: string, message: string, details?: unknown): never {
  throw new LedgerError(code, message, details);
}
