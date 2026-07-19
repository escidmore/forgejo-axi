import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';

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
  host = '127.0.0.1',
): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  let handlerError: unknown;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const recorded: RecordedRequest = {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
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
  server.listen(0, host);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing server address');
  const urlHost = host.includes(':') ? `[${host}]` : host;
  return {
    baseUrl: `http://${urlHost}:${address.port}${prefix}`,
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
