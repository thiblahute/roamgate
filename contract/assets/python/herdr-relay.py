import os, socket, sys, threading, time
herdr, path = sys.argv[1], sys.argv[2]
NL = bytes([10])
directory = os.path.dirname(path)
os.makedirs(directory, mode=0o700, exist_ok=True)
def stale(other):
    probe = socket.socket(socket.AF_UNIX)
    try:
        probe.connect(other)
        return False
    except ConnectionRefusedError:
        return True
    except OSError:
        return False
    finally:
        probe.close()
for name in os.listdir(directory):
    other = os.path.join(directory, name)
    if name.startswith("herdr-relay-") and name.endswith(".sock") and other != path and stale(other):
        try:
            os.unlink(other)
        except OSError:
            pass
try:
    os.unlink(path)
except OSError:
    pass
mask = os.umask(0o177)
server = socket.socket(socket.AF_UNIX)
server.bind(path)
os.umask(mask)
server.listen(128)
def pump(source, target):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            target.sendall(data)
    except OSError:
        pass
    try:
        target.shutdown(socket.SHUT_WR)
    except OSError:
        pass
def serve(client):
    upstream = None
    try:
        request = b""
        while NL not in request and len(request) < 1048576:
            data = client.recv(65536)
            if not data:
                break
            request += data
        if request:
            upstream = socket.socket(socket.AF_UNIX)
            upstream.connect(herdr)
            upstream.sendall(request)
            back = threading.Thread(target=pump, args=(upstream, client))
            back.daemon = True
            back.start()
            pump(client, upstream)
            back.join()
    except OSError:
        pass
    finally:
        client.close()
        if upstream is not None:
            upstream.close()
def accept():
    while True:
        try:
            client, _ = server.accept()
        except OSError:
            time.sleep(0.05)
            continue
        worker = threading.Thread(target=serve, args=(client,))
        worker.daemon = True
        worker.start()
listener = threading.Thread(target=accept)
listener.daemon = True
listener.start()
sys.stdout.write("roamgate-herdr-relay ready" + chr(10))
sys.stdout.flush()
try:
    while sys.stdin.buffer.read(65536):
        pass
finally:
    try:
        os.unlink(path)
    except OSError:
        pass
