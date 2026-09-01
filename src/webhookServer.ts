import http from 'node:http';

import type { Logging } from 'homebridge';

export type WebhookParameters = Readonly<Record<string, string>>;
export type WebhookHandler = (parameters: WebhookParameters) => Promise<void> | void;

export class WebhookServer {
  private server?: http.Server;

  constructor(
    private readonly port: number,
    private readonly log: Logging,
    private readonly handler: WebhookHandler,
    private readonly debug = false,
  ) {}

  async start(): Promise<void> {
    if (this.server?.listening) {
      return;
    }

    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port);
    });

    server.on('error', error => {
      this.log.error(`Webhook server error: ${error.message}`);
    });
    this.server = server;
    this.log.info(`Webhook server listening on port ${this.port}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;

    if (!server?.listening) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    this.log.info(`Webhook server on port ${this.port} stopped`);
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (this.debug) {
        this.log.debug(`Webhook request: ${request.method ?? 'UNKNOWN'} ${request.url ?? '/'}`);
      }
      const url = new URL(request.url ?? '/', 'http://localhost');

      if (url.pathname !== '/') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not Found');
        return;
      }

      const parameters: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        parameters[key] = value;
      }

      await this.handler(parameters);
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('OK');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`Unable to process webhook: ${message}`);
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Internal Server Error');
    }
  }
}
