import { usageError } from './errors.js';

type FlagKind = 'boolean' | 'value';
export type FlagSpec = Readonly<Record<string, FlagKind>>;

export interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

// Hand-rolled on purpose: node:util's parseArgs expands `-abc` into per-letter
// short options and accepts a bare `-` as a positional, so its rejections name
// tokens the user never typed. This CLI's contract is to echo flags as typed.
export function parseArgs(
  args: readonly string[],
  spec: FlagSpec,
  command: string,
): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!argument.startsWith('-')) {
      positionals.push(argument);
      continue;
    }

    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1);
    const kind = spec[name];
    if (!kind) {
      throw usageError(`Unknown flag ${name} for \`${command}\``, [
        `Valid flags: ${Object.keys(spec).sort().join(', ') || 'none'}`,
        `Run \`forgejo-axi ${command} --help\``,
      ]);
    }
    if (Object.hasOwn(flags, name)) {
      throw usageError(`Flag ${name} may only be supplied once`);
    }

    if (kind === 'boolean') {
      if (inlineValue !== undefined) {
        throw usageError(`${name} does not accept a value`);
      }
      flags[name] = true;
      continue;
    }

    const value = inlineValue ?? args[index + 1];
    if (
      value === undefined ||
      (inlineValue === undefined && value.startsWith('-'))
    ) {
      throw usageError(`${name} requires a value`);
    }
    flags[name] = value;
    if (inlineValue === undefined) index += 1;
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
