# Stand-in for speed.cloudflare.com. URL prefix selects behaviour:
#   /r<bytes_per_sec>/...  throttle each connection to that rate
#   /rl/...                answer downloads with HTTP 429
import http.server, socketserver, time, urllib.parse, re
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass
    def parse(self):
        u = urllib.parse.urlparse(self.path)
        m = re.match(r'^/(r(\d+)|rl)(/.*)$', u.path)
        rate, limited, path = 25_000_000, False, u.path
        if m:
            path = m.group(3)
            if m.group(1) == 'rl': limited = True
            else: rate = int(m.group(2))
        return path, urllib.parse.parse_qs(u.query), rate, limited
    def do_GET(self):
        path, q, rate, limited = self.parse()
        if path == '/cdn-cgi/trace':
            b = b'colo=TEST\nip=203.0.113.9\n'; self.send_response(200); self.send_header('Content-Length', len(b)); self.end_headers(); self.wfile.write(b); return
        if limited:
            b = b'rate limited\n'; self.send_response(429); self.send_header('Content-Length', len(b)); self.end_headers(); self.wfile.write(b); return
        n = int(q['bytes'][0])
        self.send_response(200); self.send_header('Content-Length', n); self.end_headers()
        chunk = b'\0' * 65536
        t0 = time.monotonic(); sent = 0
        try:
            while sent < n:
                k = min(n - sent, len(chunk)); self.wfile.write(chunk[:k]); sent += k
                d = sent / rate - (time.monotonic() - t0)
                if d > 0: time.sleep(d)
        except (BrokenPipeError, ConnectionResetError): pass
    def do_POST(self):
        path, q, rate, limited = self.parse()
        rate = rate / 5
        t0 = time.monotonic(); total = 0
        try:
            while True:
                line = self.rfile.readline()
                if not line: return
                size = int(line.strip() or b'0', 16)
                if size == 0: break
                self.rfile.read(size + 2); total += size
                d = total / rate - (time.monotonic() - t0)
                if d > 0: time.sleep(d)
        except Exception: return
        self.send_response(200); self.send_header('Content-Length', 2); self.end_headers(); self.wfile.write(b'ok')
class S(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True
S(('0.0.0.0', 8099), H).serve_forever()
