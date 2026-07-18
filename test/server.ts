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
): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
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
