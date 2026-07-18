export function testSubprocessEnv(
  overrides: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (name === 'FORGEJO_TOKEN' || name.startsWith('FORGEJO_TOKEN_')) {
      delete env[name];
    }
  }
  return { ...env, ...overrides };
}
