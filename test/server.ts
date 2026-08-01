import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { text } from 'node:stream/consumers';
import { main } from '../src/cli.js';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface FakeServer {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

export async function startServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    recorded: RecordedRequest,
  ) => void | Promise<void>,
  prefix = '',
): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  let handlerError: unknown;
  const server = createServer(async (request, response) => {
    try {
      const recorded: RecordedRequest = {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        body: await text(request),
      };
      requests.push(recorded);
      await handler(request, response, recorded);
    } catch (error) {
      handlerError ??= error;
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing server address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}${prefix}`,
    requests,
    close: async () => {
      server.close();
      await once(server, 'close');
      if (handlerError) throw handlerError;
    },
  };
}

export function json(
  response: ServerResponse,
  status: number,
  data: unknown,
): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(data));
}

/** Servers a test registers here are closed for it by `closeServers`. */
export const servers: FakeServer[] = [];

export async function closeServers(): Promise<void> {
  process.exitCode = undefined;
  await Promise.all(servers.splice(0).map((server) => server.close()));
}

/** CLI connection flags for a fake-server test repository. */
export function connection(server: FakeServer, json = true): string[] {
  return [
    '--repo',
    'acme/widgets',
    '--base-url',
    server.baseUrl,
    ...(json ? ['--json'] : []),
  ];
}

export async function loadFixture<T>(version: 15 | 16): Promise<T> {
  return parseJson<T>(
    await readFile(
      new URL(`./fixtures/forgejo-${version}.json`, import.meta.url),
      'utf8',
    ),
  );
}

/** Drive the CLI the way a shell would, capturing stdout and the exit code. */
export async function invoke(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ output: string; exitCode: number | undefined }> {
  let output = '';
  process.exitCode = undefined;
  await main({
    argv,
    env,
    stdout: {
      write: (chunk) => {
        output += String(chunk);
        return true;
      },
    },
  });
  return { output, exitCode: process.exitCode };
}

export function parseJson<T = unknown>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Expected valid JSON: ${String(error)}`, { cause: error });
  }
}
