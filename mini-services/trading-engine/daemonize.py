#!/usr/bin/env python3
"""Daemon launcher: double-fork to fully detach from controlling shell.

Usage: python3 daemonize.py <workdir> <command> [args...]
Output is redirected to a log file given by the ENGINE_LOG env var (or
/home/z/my-project/engine.log by default).
"""
import os
import sys
import signal
import time

def main():
    if len(sys.argv) < 3:
        print("usage: daemonize.py <workdir> <command> [args...]", file=sys.stderr)
        sys.exit(2)
    workdir = sys.argv[1]
    cmd = sys.argv[2:]
    log_path = os.environ.get("ENGINE_LOG", "/home/z/my-project/engine.log")

    # First fork
    pid = os.fork()
    if pid > 0:
        # Parent: wait briefly for the daemon to write its pid file, then exit.
        # We must return immediately so the bash command can finish.
        sys.stdout.write(f"daemonize: parent exiting, child forked\n")
        sys.stdout.flush()
        os._exit(0)

    # Child: become session leader, drop controlling terminal
    os.setsid()
    # Ignore SIGHUP so a second fork doesn't get killed when session leader exits
    signal.signal(signal.SIGHUP, signal.SIG_IGN)

    # Second fork (classic daemon pattern, prevents reacquiring a tty)
    pid = os.fork()
    if pid > 0:
        os._exit(0)

    # Grandchild (daemon)
    os.chdir(workdir)
    # Reset umask
    os.umask(0o022)
    # Close stdin/stdout/stderr and reopen to /dev/null and log file
    os.close(0)
    os.close(1)
    os.close(2)
    fd_in = os.open("/dev/null", os.O_RDONLY)
    fd_out = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    fd_err = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    # dup to 0,1,2
    os.dup2(fd_in, 0)
    os.dup2(fd_out, 1)
    os.dup2(fd_err, 2)
    if fd_in > 2: os.close(fd_in)
    if fd_out > 2: os.close(fd_out)
    if fd_err > 2: os.close(fd_err)

    # Exec the requested command
    try:
        os.execvp(cmd[0], cmd)
    except Exception as e:
        # Write to log
        with open(log_path, "a") as f:
            f.write(f"daemonize: exec failed: {e}\n")
        os._exit(127)

if __name__ == "__main__":
    main()
