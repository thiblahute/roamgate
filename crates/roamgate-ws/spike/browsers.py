"""Runs the spike page in Chromium, Google Chrome, Firefox (Playwright) and
WebKitGTK (the system one, under Xvfb) against three servers: the Rust
transport, yawc, and the Bun server's own websocket-send code. Each run goes
through a proxy that counts the bytes the server wrote, so the wire sizes
compare across implementations.

python3 browsers.py path/to/ws-spike [--out results.json]
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))


def start(command, cwd=None):
    server = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    line = server.stdout.readline().strip()
    if not line.startswith("listening on "):
        raise SystemExit(f"{command[0]} did not start: {line!r} {server.stderr.read()[-400:]}")
    for pipe in (server.stdout, server.stderr):
        threading.Thread(target=lambda p=pipe: [None for _ in p], daemon=True).start()
    return server, line.split()[-1]


class CountingProxy:
    """Forwards a port to `upstream` and counts the bytes coming back."""

    def __init__(self, upstream):
        host, port = upstream.removeprefix("http://").split(":")
        self.upstream = (host, int(port))
        self.down = 0
        self.lock = threading.Lock()
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.base = f"http://127.0.0.1:{self.listener.getsockname()[1]}"
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while True:
            client, _ = self.listener.accept()
            upstream = socket.create_connection(self.upstream)
            threading.Thread(target=self.pipe, args=(client, upstream, False), daemon=True).start()
            threading.Thread(target=self.pipe, args=(upstream, client, True), daemon=True).start()

    def pipe(self, source, target, count):
        try:
            while data := source.recv(1 << 16):
                if count:
                    with self.lock:
                        self.down += len(data)
                target.sendall(data)
        except OSError:
            pass
        finally:
            for sock in (source, target):
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def take(self):
        with self.lock:
            down, self.down = self.down, 0
        return down


def runs(proxies):
    for backend in ("roamgate", "yawc", "bun"):
        for slow in (False, True):
            yield backend, slow, proxies[backend]


def url(proxy, backend, slow):
    return f"{proxy.base}/?impl={backend}" + ("&slowack=1" if slow else "")


def playwright_runs(proxies, results):
    with sync_playwright() as p:
        browsers = [
            ("chromium", lambda: p.chromium.launch()),
            ("chrome", lambda: p.chromium.launch(executable_path="/usr/bin/google-chrome")),
            ("firefox", lambda: p.firefox.launch()),
        ]
        for name, launch in browsers:
            try:
                browser = launch()
            except Exception as error:  # noqa: BLE001
                results.append({"browser": name, "pass": False, "failures": [str(error)[:300]]})
                continue
            for backend, slow, proxy in runs(proxies):
                page = browser.new_page()
                proxy.take()
                page.goto(url(proxy, backend, slow))
                try:
                    page.wait_for_function("window.report", timeout=150_000)
                    report = page.evaluate("window.report")
                except Exception as error:  # noqa: BLE001
                    report = {"pass": False, "backend": backend, "slowAck": slow, "failures": [str(error)[:300]]}
                page.close()
                results.append({"browser": f"{name} {browser.version}", **report, "wireDown": proxy.take()})
            browser.close()


def webkit_runs(proxies, results):
    env = dict(os.environ, GDK_BACKEND="x11")
    env.pop("WAYLAND_DISPLAY", None)
    for backend, slow, proxy in runs(proxies):
        proxy.take()
        out = subprocess.run(
            ["xvfb-run", "-a", sys.executable, os.path.join(HERE, "webkit_gi.py"), url(proxy, backend, slow)],
            capture_output=True,
            text=True,
            timeout=300,
            env=env,
        )
        lines = [line for line in out.stdout.splitlines() if line.startswith("{")]
        report = json.loads(lines[-1]) if lines else None
        if report is None:
            report = {"pass": False, "backend": backend, "slowAck": slow, "failures": ["no report", out.stderr[-400:]]}
        version = subprocess.run(
            [sys.executable, "-c", "import gi; gi.require_version('WebKit','6.0'); from gi.repository import WebKit;"
             "print(f'{WebKit.get_major_version()}.{WebKit.get_minor_version()}.{WebKit.get_micro_version()}')"],
            capture_output=True, text=True,
        ).stdout.strip()
        results.append({"browser": f"webkitgtk {version}", **report, "wireDown": proxy.take()})


def main():
    binary = sys.argv[1]
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else None
    plan = os.path.join(tempfile.mkdtemp(prefix="ws-spike-"), "plan.json")
    subprocess.run([binary, "--dump-plan", plan], check=True)
    rust, rust_base = start([binary, "--listen", "127.0.0.1:0"])
    bun, bun_base = start(["bun", os.path.join(HERE, "bun-server.ts"), plan], cwd=REPO)
    rust_proxy = CountingProxy(rust_base)
    proxies = {"roamgate": rust_proxy, "yawc": rust_proxy, "bun": CountingProxy(bun_base)}
    results = []
    try:
        playwright_runs(proxies, results)
        webkit_runs(proxies, results)
    finally:
        rust.terminate()
        bun.terminate()
    for result in results:
        wire = (result.get("server") or {}).get("wire") or {}
        print(
            f"{result.get('browser', '?'):28} {result.get('backend', '?'):9} slow={str(result.get('slowAck')):5} "
            f"pass={result.get('pass')} msgs={result.get('messages')}/{result.get('expected')} "
            f"burst={result.get('burstReceived')} chunks={result.get('chunkFrames')} "
            f"echo_in_compressed={result.get('echoesCompressed')} ext={result.get('extensions')!r} "
            f"wire_down={result.get('wireDown')} server_bytes={wire.get('bytes_written')} "
            f"ms={result.get('msToComplete')} failures={result.get('failures')}"
        )
    if out:
        with open(out, "w") as handle:
            json.dump(results, handle, indent=1)
    sys.exit(0 if all(result.get("pass") for result in results) else 1)


main()
