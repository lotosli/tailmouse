"""Run Linux process-lifecycle checks with an init-like orphan reaper.

The cloud container's PID 1 is tail. Reap only descendants of this command;
do not change production lifecycle code, test assertions, or their deadlines.
"""
import ctypes
import os
import subprocess
import sys
import time

if len(sys.argv) < 2:
    raise SystemExit('A test command is required.')
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
    raise OSError(ctypes.get_errno(), 'Cannot establish test descendant reaper')
command = subprocess.Popen(sys.argv[1:])
result = None
finished = None
while True:
    try:
        pid, status = os.waitpid(-1, 0 if result is None else os.WNOHANG)
    except ChildProcessError:
        if result is None:
            raise SystemExit('Test command exit status was not collected.')
        raise SystemExit(result if result >= 0 else 128-result)
    if pid == command.pid:
        result = os.waitstatus_to_exitcode(status)
        command.returncode = result
        finished = time.monotonic()
    elif pid == 0:
        if time.monotonic() - finished > 2:
            raise SystemExit('Test command left a live descendant after exit.')
        time.sleep(0.01)
