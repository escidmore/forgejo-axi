import { describe, expect, it, vi } from 'vitest';
import { exitCleanlyOnEpipe, type ErrorEmitter } from '../src/epipe.js';

describe('stdout EPIPE handling', () => {
  it('exits successfully instead of exposing a raw stream stack trace', () => {
    let listener: ((error: NodeJS.ErrnoException) => void) | undefined;
    const stream: ErrorEmitter = {
      on: (_event, nextListener) => {
        listener = nextListener;
      },
    };
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    exitCleanlyOnEpipe(stream, exit);
    expect(() =>
      listener?.(Object.assign(new Error('broken pipe'), { code: 'EPIPE' })),
    ).toThrow('exit:0');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('does not hide unrelated stdout failures', () => {
    let listener: ((error: NodeJS.ErrnoException) => void) | undefined;
    exitCleanlyOnEpipe({
      on: (_event, nextListener) => {
        listener = nextListener;
      },
    });
    const error = Object.assign(new Error('bad stream'), { code: 'EIO' });
    expect(() => listener?.(error)).toThrow(error);
  });
});
