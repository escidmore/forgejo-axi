import { describe, expect, it } from 'vitest';
import { testSubprocessEnv } from './environment.js';

describe('test subprocess environment', () => {
  it('scrubs only Forgejo tokens while preserving GitHub authentication', () => {
    const env = testSubprocessEnv(
      {},
      {
        FORGEJO_TOKEN: 'dummy-generic',
        FORGEJO_TOKEN_FORGEJO_2E_EXAMPLE: 'dummy-scoped',
        GH_TOKEN: 'dummy-gh',
        GITHUB_TOKEN: 'dummy-github',
      },
    );
    expect(env).not.toHaveProperty('FORGEJO_TOKEN');
    expect(env).not.toHaveProperty('FORGEJO_TOKEN_FORGEJO_2E_EXAMPLE');
    expect(env).toMatchObject({
      GH_TOKEN: 'dummy-gh',
      GITHUB_TOKEN: 'dummy-github',
    });
  });

  it('permits an explicit dummy Forgejo token for authenticated tests', () => {
    const env = testSubprocessEnv(
      { FORGEJO_TOKEN_TEST: 'explicit-dummy' },
      { FORGEJO_TOKEN_LEAK: 'must-be-scrubbed' },
    );
    expect(env).toEqual({ FORGEJO_TOKEN_TEST: 'explicit-dummy' });
  });
});
