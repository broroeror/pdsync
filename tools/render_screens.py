"""Render the desktop app's screens to PNG headlessly, with made-up example data.

    QT_QPA_PLATFORM=offscreen QT_QUICK_CONTROLS_STYLE=Fusion \\
        python3 tools/render_screens.py OUT.png TAB [SCENARIO]

TAB: 0 = Status, 1 = Review, 2 = Settings.
SCENARIO: ok (default) | syncing | stopped | full | measured | loggedout | humancheck | move
Used to check layouts without touching a real account or the real state.
"""

import os
import sys
import tempfile
import time
from pathlib import Path

import shiboken6
from PySide6.QtCore import QObject, QTimer, QUrl, Slot
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuick import QQuickWindow
from PySide6.QtWidgets import QApplication

GUI = Path(__file__).resolve().parents[1] / "gui"
sys.path.insert(0, str(GUI))
from pdsync_gui import backend as B  # noqa: E402

out, tab = sys.argv[1], int(sys.argv[2])
scenario = sys.argv[3] if len(sys.argv) > 3 else "ok"
now = time.time() * 1000


class Fake(B.Backend):
    """The real backend's properties, fed fixed data; never runs the engine."""

    def __init__(self):
        B.STATE_DIR = Path(tempfile.mkdtemp(prefix="pdsync-render-"))
        super().__init__()

    @Slot()
    def refresh(self):
        pass


app = QApplication([])
fake = Fake()
fake._activity = [
    {"timeMs": now - 1000, "kind": "created", "path": "Projects/site/", "folder": "Documents", "detail": "folder created on Drive"},
    {"timeMs": now - 2000, "kind": "upload", "path": "Projects/site/index.html", "folder": "Documents"},
    {"timeMs": now - 86_400_000 * 2, "kind": "download", "path": "Photos/beach.jpg", "folder": "My Files"},
]
fake._status = {
    "username": None if scenario in ("loggedout", "humancheck") else "tester@example.com",
    "syncAccount": "tester@example.com",
    "folder": "/home/user/DriveMirror",
    "firstSyncDone": True,
    "computerName": "my-pc",
    "running": scenario == "syncing",
    "progress": {"startedMs": now - 3_180_000, "lastMs": now - 1000, "lastItem": "Projects/site/index.html",
                 "folder": "Documents", "created": 9985, "uploaded": 120, "downloaded": 3} if scenario == "syncing" else None,
    "folders": [
        {"id": "myfiles", "kind": "myfiles", "label": "My Files", "local": "/home/user/DriveMirror",
         "firstSyncDone": True, "excludes": {"defaults": True, "custom": []}},
        {"id": "a1", "kind": "computer", "label": "Documents", "local": "/home/user/Documents",
         "firstSyncDone": False, "excludes": {"defaults": True, "custom": ["*.iso", "Projects/old"]}},
    ],
    "lastRun": {"finishedMs": now - 60_000, "downloaded": 0, "skipped": 0, "failures": 0,
                "errorKind": "stopped" if scenario == "stopped" else None,
                "error": "Stopped by you" if scenario == "stopped" else None},
    "reviewCount": 0,
    "uploads": ["new", "moves"],
    "massDeleteHeld": 0,
    "storage": {"used": 2_147_483_594, "max": 2_147_483_648},
    "spaceWaiting": {"files": 30412, "bytes": 2_254_857_830} if scenario == "full" else None,
    "trash": {"kind": "desktop"},
    "service": {"enabled": True, "intervalMinutes": 5, "nextRunMs": now + 1e5},
}

engine = QQmlApplicationEngine()
engine.rootContext().setContextProperty("backend", fake)
engine.load(QUrl.fromLocalFile(str(GUI / "pdsync_gui" / "qml" / "Main.qml")))
if not engine.rootObjects():
    sys.exit("QML failed to load")
win = shiboken6.wrapInstance(shiboken6.getCppPointer(engine.rootObjects()[0])[0], QQuickWindow)
win.setProperty("height", 640)
if os.environ.get("RENDER_WIDTH"):  # e.g. 620, to check wrapping in a narrow window
    win.setProperty("width", int(os.environ["RENDER_WIDTH"]))
win.show()
if scenario == "humancheck":
    fake._login_url = "https://verify.proton.me/?methods=captcha&token=EXAMPLE"
    fake._set_login("need-humanVerification")
fake.changed.emit()
win.findChild(QObject, "tabs").setProperty("currentIndex", tab)
if scenario == "measured":
    QTimer.singleShot(300, lambda: fake.folderMeasured.emit(
        "/home/user/Documents",
        "/home/user/Documents\n\n81,206 files (5.2 GB).\n"
        "After skipping node_modules, .git, caches and similar: 31,048 files (2.1 GB).",
    ))
if scenario == "move":
    QTimer.singleShot(300, lambda: fake.moveProposed.emit("myfiles", "/home/user/DriveMirror", "/mnt/BigDrive/DriveMirror"))
QTimer.singleShot(800, lambda: (win.grabWindow().save(out), app.quit()))
app.exec()
