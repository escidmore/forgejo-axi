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
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const valid = Object.keys(spec).sort((left, right) =>
    left.localeCompare(right),
  );

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
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
        `Valid flags: ${valid.join(', ') || 'none'}`,
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
  if (parsed.positionals.length !== 1) {
    throw usageError(
      parsed.positionals.length === 0
        ? `${label} is required`
        : `Unexpected arguments: ${parsed.positionals.slice(1).join(' ')}`,
      [`Run \`forgejo-axi ${parsed.command} --help\``],
    );
  }
  const value = parsed.positionals[0];
  if (!value) {
    throw usageError(`${label} is required`, [
      `Run \`forgejo-axi ${parsed.command} --help\``,
    ]);
  }
  return value;
}

export function rejectPositionals(parsed: ParsedArgs): void {
  if (parsed.positionals.length > 0) {
    throw usageError(`Unexpected arguments: ${parsed.positionals.join(' ')}`);
  }
}
