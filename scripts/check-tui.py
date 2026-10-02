#!/usr/bin/env python3
"""Opt-in real Pi PTY check: python3 scripts/check-tui.py /path/to/pi/dist/cli.js [glance/index.ts]."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

root = Path(__file__).resolve().parent.parent
cli = Path(sys.argv[1]).resolve()
glance = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None
for mode in ["regular", "fullscreen"]:
    for with_glance in ([False, True] if glance else [False]):
        with tempfile.TemporaryDirectory(prefix="pi-translate-tui-") as tmp:
            directory = Path(tmp)
            events = directory / "events.log"
            config = directory / "translate.json"
            config.write_text(json.dumps({"enabled": False, "timeoutMs": 123456}))
            (directory / "settings.json").write_text(json.dumps({"quietStartup": True, "theme": "dark"}))
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 100, 0, 0))
            env = {**os.environ, "PI_CODING_AGENT_DIR": tmp, "PI_TRANSLATE_CONFIG": str(config), "PI_TRANSLATE_TUI_EVENTS": str(events), "PI_OFFLINE": "1", "TERM": "xterm-256color"}
            args = ["node", str(cli), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session", "--no-approve", "--tui-mode", mode, "-e", str(root / "scripts/tui-fixture.ts")]
            if with_glance:
                args += ["-e", str(glance)]
            process = subprocess.Popen(args, cwd=tmp, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
            os.close(slave)
            chunks = bytearray()

            def drain(seconds=0.25):
                until = time.monotonic() + seconds
                while time.monotonic() < until:
                    if select.select([master], [], [], 0.03)[0]:
                        try:
                            data = os.read(master, 65536)
                        except OSError:
                            break
                        chunks.extend(data)
                        # Respond to cursor-position query; no real terminal emulator is attached.
                        if b"\x1b[6n" in data:
                            os.write(master, b"\x1b[1;1R")

            def send(data):
                os.write(master, data)
                drain()

            try:
                drain(4)
                baseline = len(chunks)
                send(b"/translate")
                send(b"\r")
                drain(0.5)
                assert events.exists(), chunks.decode(errors="replace")[-4000:]
                # Model search / cancel; no models are loaded with live credentials here.
                send(b"\r")
                send(b"flash")
                send(b"\x1b")
                # Timeout custom editor / return / cancel without saving.
                for _ in range(3):
                    send(b"\x1b[B")
                send(b"\r")
                for _ in range(6):
                    send(b"\x1b[B")
                send(b"\r")
                send(b"\x15")
                send(b"3601")
                send(b"\r")
                send(b"\x1b")
                send(b"\x1b")
                # Select Jev, then enter/cancel the classifier picker.
                send(b"\x1b[B")
                send(b"\r")
                drain(0.3)
                send(b"\x1b[B")
                send(b"\r")
                send(b"\x1b")
                before_resize = bytes(chunks[baseline:])
                assert b"\x1b[2J" not in before_resize, "unexpected full clear during submenu navigation"
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 12, 42, 0, 0))
                os.kill(process.pid, signal.SIGWINCH)
                drain()
                send(b"\x1b")
                recorded = events.read_text().splitlines()
                assert recorded == ["mount", "dispose", "editor-restored"], recorded
                saved = json.loads(config.read_text())
                assert saved["timeoutMs"] == 123456, saved
                assert saved.get("decisionMode") == "jev", saved
                print(json.dumps({"pi": str(cli), "mode": mode, "glance": with_glance, "events": recorded, "fullClearsBeforeResize": 0}))
            finally:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                os.close(master)
