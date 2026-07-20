export interface ErrorEmitter {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
}

export function exitCleanlyOnEpipe(
  stream: ErrorEmitter,
  exit: (code: number) => never = process.exit,
): void {
  stream.on('error', (error) => {
    if (error.code === 'EPIPE') exit(0);
    throw error;
  });
}
