import http from 'node:http';
import https from 'node:https';

import type { HttpMethod } from './types.js';

export interface HttpClientOptions {
  method: HttpMethod;
  timeout: number;
  username?: string;
  password?: string;
  verifyTls: boolean;
}

const MAX_REDIRECTS = 5;

/**
 * Minimal dependency-free HTTP client for triggering a relay endpoint.
 *
 * Any completed HTTP response is treated as a successful relay trigger. This
 * intentionally retains the behavior of the previous `request`-based client.
 */
export class HttpClient {
  constructor(private readonly options: HttpClientOptions) {}

  request(urlValue: string): Promise<void> {
    let url: URL;

    try {
      url = new URL(urlValue);
    } catch (error) {
      return Promise.reject(new Error(`Invalid relay URL: ${urlValue}`, { cause: error }));
    }

    return this.requestUrl(url, url.origin, 0);
  }

  private requestUrl(url: URL, credentialOrigin: string, redirectCount: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        reject(new Error(`Unsupported relay URL protocol: ${url.protocol}`));
        return;
      }

      const transport = url.protocol === 'https:' ? https : http;
      const headers: http.OutgoingHttpHeaders = {};

      if (this.options.username && this.options.password && url.origin === credentialOrigin) {
        const credentials = Buffer.from(`${this.options.username}:${this.options.password}`).toString('base64');
        headers.authorization = `Basic ${credentials}`;
      }

      if (this.options.method === 'POST') {
        headers['content-length'] = '0';
      }

      const request = transport.request(url, {
        headers,
        method: this.options.method,
        rejectUnauthorized: this.options.verifyTls,
      }, response => {
        const location = response.headers.location;
        const followsRedirect = this.options.method === 'GET'
          && response.statusCode !== undefined
          && response.statusCode >= 300
          && response.statusCode < 400
          && location !== undefined;

        response.resume();
        response.once('error', reject);
        response.once('end', () => {
          if (!followsRedirect) {
            resolve();
            return;
          }

          if (redirectCount >= MAX_REDIRECTS) {
            reject(new Error(`Relay request exceeded ${MAX_REDIRECTS} redirects`));
            return;
          }

          let redirectUrl: URL;
          try {
            redirectUrl = new URL(location, url);
          } catch (error) {
            reject(new Error(`Invalid relay redirect URL: ${location}`, { cause: error }));
            return;
          }

          this.requestUrl(redirectUrl, credentialOrigin, redirectCount + 1).then(resolve, reject);
        });
      });

      request.setTimeout(this.options.timeout, () => {
        request.destroy(new Error(`Relay request timed out after ${this.options.timeout}ms`));
      });
      request.once('error', reject);
      request.end();
    });
  }
}
