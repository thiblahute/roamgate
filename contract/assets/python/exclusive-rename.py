
import ctypes, os, sys
source, target = sys.argv[1:]
if source == target:
    sys.exit("Source and destination are identical")
libc = ctypes.CDLL(None, use_errno=True)
try:
    if sys.platform == "darwin":
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        args = [os.fsencode(source), os.fsencode(target), 4]
    elif sys.platform.startswith("linux"):
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        args = [-100, os.fsencode(source), -100, os.fsencode(target), 1]
    else:
        raise AttributeError()
except AttributeError:
    sys.exit("Atomic file moves are unsupported on this host")
rename.restype = ctypes.c_int
result = rename(*args)
if result != 0:
    sys.exit(os.strerror(ctypes.get_errno()))
