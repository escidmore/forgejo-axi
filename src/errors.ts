import { AxiError } from 'axi-sdk-js';

export type ErrorDetails = Record<string, unknown>;

export class ForgejoAxiError extends AxiError {
  readonly details: ErrorDetails;
  readonly usage: boolean;

  constructor(
    message: string,
    code: string,
    options: {
      details?: ErrorDetails;
      suggestions?: string[];
      usage?: boolean;
    } = {},
  ) {
    super(message, code, options.suggestions ?? []);
    this.name = 'ForgejoAxiError';
    this.details = options.details ?? {};
    this.usage = options.usage ?? code === 'VALIDATION_ERROR';
  }
}

export function usageError(
  message: string,
  suggestions: string[] = [],
): ForgejoAxiError {
  return new ForgejoAxiError(message, 'VALIDATION_ERROR', {
    suggestions,
    usage: true,
  });
}

export function asForgejoError(error: unknown): ForgejoAxiError {
  if (error instanceof ForgejoAxiError) return error;
  if (error instanceof AxiError) {
    return new ForgejoAxiError(error.message, error.code, {
      suggestions: error.suggestions,
    });
  }
  return new ForgejoAxiError(
    error instanceof Error ? error.message : String(error),
    'UNKNOWN',
  );
}
