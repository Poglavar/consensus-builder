#!/usr/bin/env python3
"""Serve only the local comparison artifacts, on loopback with caching disabled."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        super().end_headers()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--port', type=int, default=8097)
    args = parser.parse_args()
    handler = partial(NoCacheHandler, directory=args.directory)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    print(f'Comparison: http://localhost:{args.port}/', flush=True)
    server.serve_forever()
