import { PassThrough, Writable } from 'node:stream';

export function inMemoryFetch(server) {
  return (input, options = {}) => new Promise((resolve, reject) => {
    const url = new URL(input, 'http://in-memory.test');
    const request = new PassThrough();
    request.url = `${url.pathname}${url.search}`;
    request.method = options.method || 'GET';
    request.headers = Object.fromEntries(new Headers(options.headers || {}));
    request.headers.host = url.host;
    let bodyController;
    const body = new ReadableStream({
      start(controller) { bodyController = controller; },
      cancel() { response.destroy(); request.destroy(); },
    });
    const response = new Writable({
      write(chunk, encoding, callback) { bodyController.enqueue(new Uint8Array(chunk)); callback(); },
      final(callback) { bodyController.close(); callback(); },
      destroy(error, callback) {
        if (error) bodyController.error(error);
        callback(error);
      },
    });
    response.writeHead = (status, headers) => {
      resolve(new Response(body, { status, headers }));
      return response;
    };
    response.on('error', reject);
    request.on('error', reject);
    if (options.signal) options.signal.addEventListener('abort', () => {
      response.destroy(options.signal.reason);
      request.destroy();
    }, { once: true });
    server.emit('request', request, response);
    request.end(options.body);
  });
}
