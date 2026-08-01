import { parseArgs as tokenize } from 'node:util';
import { usageError } from './errors.js';

type FlagKind = 'boolean' | 'value';
export type FlagSpec = Readonly<Record<string, FlagKind>>;

export interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export function parseArgs(
  args: readonly string[],
  spec: FlagSpec,
  command: string,
): ParsedArgs {
  const options: Record<string, { type: 'string' | 'boolean' }> = {};
  for (const [name, kind] of Object.entries(spec)) {
    options[name.slice(2)] = { type: kind === 'value' ? 'string' : 'boolean' };
  }
  // Non-strict tokenizing keeps every rejection, and its message, local.
  const { positionals, tokens } = tokenize({
    args: [...args],
    options,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const flags: Record<string, string | boolean> = {};
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    const kind = spec[token.rawName];
    if (!kind) {
      throw usageError(`Unknown flag ${token.rawName} for \`${command}\``, [
        `Valid flags: ${Object.keys(spec).sort().join(', ') || 'none'}`,
        `Run \`forgejo-axi ${command} --help\``,
      ]);
    }
    if (Object.hasOwn(flags, token.rawName)) {
      throw usageError(`Flag ${token.rawName} may only be supplied once`);
    }
    if (kind === 'boolean') {
      if (token.value !== undefined) {
        throw usageError(`${token.rawName} does not accept a value`);
      }
      flags[token.rawName] = true;
      continue;
    }
    if (
      token.value === undefined ||
      (!token.inlineValue && token.value.startsWith('-'))
    ) {
      throw usageError(`${token.rawName} requires a value`);
    }
    flags[token.rawName] = token.value;
  }
  return { command, flags, positionals };
}

export function stringFlag(
  parsed: ParsedArgs,
  name: string,
): string | undefined {
  const value = parsed.flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function boolFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

export function requireFlag(parsed: ParsedArgs, name: string): string {
  const value = stringFlag(parsed, name);
  if (value === undefined || value.length === 0) {
    throw usageError(`${name} is required`, [
      `Run \`forgejo-axi ${parsed.command} --help\``,
    ]);
  }
  return value;
}

export function requireOnePositional(
  parsed: ParsedArgs,
  label: string,
): string {
  const [value, ...extra] = parsed.positionals;
  const help = [`Run \`forgejo-axi ${parsed.command} --help\``];
  if (extra.length > 0) {
    throw usageError(`Unexpected arguments: ${extra.join(' ')}`, help);
  }
  if (!value) {
    throw usageError(`${label} is required`, help);
  }
  return value;
}

export function rejectPositionals(parsed: ParsedArgs): void {
  if (parsed.positionals.length > 0) {
    throw usageError(`Unexpected arguments: ${parsed.positionals.join(' ')}`);
  }
}

export function positiveInteger(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value))
    throw usageError(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw usageError(`${label} is too large`);
  return parsed;
}
