#!/usr/bin/python3
"""Give the unmodified command independent real OS stdout/stderr pipes.

fd 3 is a private launcher-status channel; close_fds keeps it out of the guest.
The Node owner kills our detached process group on timeout, output overflow,
interruption, and after completion. Bubblewrap also kills its PID namespace
when this supervisor dies (--die-with-parent).
"""

import array
import ctypes
import fcntl
import json
import os
import select
import signal
import subprocess
import sys
import termios


def forward(destination, chunk):
    remaining = memoryview(chunk)
    while remaining:
        remaining = remaining[os.write(destination, remaining):]


def main():
    # Preserve the direct Node -> bubblewrap parent-death chain despite this
    # supervisor. Check the expected parent after installing protection so an
    # owner which died during Python startup cannot leave a guest behind.
    expected_parent = int(sys.argv[1])
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    if os.getppid() != expected_parent:
        os.kill(os.getpid(), signal.SIGKILL)
    child = subprocess.Popen(
        sys.argv[2:], stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True
    )
    with child.stdout, child.stderr:
        streams = {child.stdout.fileno(): 1, child.stderr.fileno(): 2}
        while streams:
            if child.poll() is not None:
                # A background descendant can retain either stream after the
                # command exits. Drain bytes already written, not a future EOF
                # which may never arrive. Node kills the remaining group when
                # we exit, just as for the directly spawned command's exit.
                for fd, destination in streams.items():
                    pending = array.array("i", [0])
                    fcntl.ioctl(fd, termios.FIONREAD, pending, True)
                    remaining = pending[0]
                    while remaining:
                        chunk = os.read(fd, min(remaining, 65536))
                        if not chunk:
                            break
                        forward(destination, chunk)
                        remaining -= len(chunk)
                break
            for fd in select.select(list(streams), [], [], 0.05)[0]:
                chunk = os.read(fd, 65536)
                if chunk:
                    forward(streams[fd], chunk)
                else:
                    del streams[fd]
    status = child.wait()
    # subprocess uses negative signal numbers; match the shell convention.
    if status < 0:
        status = 128 - status
    os.write(3, (json.dumps({"status": status}) + "\n").encode("ascii"))


if __name__ == "__main__":
    main()
