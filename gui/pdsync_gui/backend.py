"""Bridge between the QML UI and the pdsync engine.

The app never talks to Drive itself: every action is an engine command
(`pdsync <command> --json`), run asynchronously with QProcess. The engine
touches `<state dir>/changed` whenever something happens, and we refresh then.
"""

import json
import os
import time
from pathlib import Path

from PySide6.QtCore import (
    Property,
    QFileSystemWatcher,
    QObject,
    QProcess,
    QTimer,
    QUrl,
    Signal,
    Slot,
)
from PySide6.QtCore import QDateTime, QLocale
from PySide6.QtGui import QDesktopServices

STATE_DIR = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state") / "pdsync"
AUTOSTART_FILE = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "autostart/pdsync-gui.desktop"
# Refresh relative times ("3 min ago") and catch runs started by the timer.
TICK_MS = 30_000


def engine_command() -> list[str]:
    """The engine to run: $PDSYNC_BIN, else the dev launcher, else `pdsync` on PATH."""
    if env := os.environ.get("PDSYNC_BIN"):
        return [env]
    dev = Path(__file__).resolve().parents[2] / "bin" / "pdsync"
    return [str(dev)] if dev.is_file() else ["pdsync"]


def describe_version(side: dict | None) -> dict:
    """Date/time and size of one side of a review item, formatted for display."""
    if not side:
        return {"known": False, "when": "", "size": ""}
    locale = QLocale.system()
    when = locale.toString(QDateTime.fromMSecsSinceEpoch(int(side["mtimeMs"])), QLocale.FormatType.ShortFormat)
    size = side.get("size")
    return {
        "known": True,
        "when": when,
        "size": locale.formattedDataSize(size) if size is not None else "",
    }


def clock_time(ms: int | None) -> str:
    """'11:38:24' today (with seconds, so progress is visible), else date + time."""
    if not ms:
        return ""
    locale = QLocale.system()
    moment = QDateTime.fromMSecsSinceEpoch(int(ms))
    # The locale's long time format includes seconds; drop any time zone part.
    time_fmt = locale.timeFormat(QLocale.FormatType.LongFormat).replace(" t", "").replace("t", "").strip()
    if moment.date() == QDateTime.currentDateTime().date():
        return locale.toString(moment.time(), time_fmt)
    return locale.toString(moment, QLocale.FormatType.ShortFormat)


def relative_time(ms: int | None, future: bool = False) -> str:
    if not ms:
        return ""
    seconds = (ms / 1000 - time.time()) if future else (time.time() - ms / 1000)
    if seconds < 60:
        return "in under a minute" if future else "just now"
    minutes = round(seconds / 60)
    if minutes < 60:
        text = f"{minutes} min"
    elif minutes < 48 * 60:
        text = f"{round(minutes / 60)} h"
    else:
        text = f"{round(minutes / 1440)} days"
    return f"in {text}" if future else f"{text} ago"


class Backend(QObject):
    changed = Signal()
    loginChanged = Signal()
    # For the tray: (title, message) worth a desktop notification.
    notify = Signal(str, str)
    showWindowRequested = Signal()
    # A folder's size, measured before adding it: (path, summary text).
    folderMeasured = Signal(str, str)

    def __init__(self):
        super().__init__()
        self._cmd = engine_command()
        self._status: dict = {}
        self._activity: list = []
        self._review: list = []
        self._syncing = False
        self._busy_action = ""
        self._login_state = "idle"  # idle | working | need-totp | need-mailboxPassword
        self._login_error = ""
        self._login_proc: QProcess | None = None
        self._procs: set[QProcess] = set()
        self._refreshing = False
        self._refresh_queued = False
        self._last_refresh = 0.0
        self._last_state = None
        self._last_review_count = 0

        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self._watcher = QFileSystemWatcher([str(STATE_DIR)])
        self._watch_changed_file()
        self._watcher.directoryChanged.connect(self._on_fs_change)
        self._watcher.fileChanged.connect(self._on_fs_change)

        self._tick = QTimer(self, interval=TICK_MS)
        self._tick.timeout.connect(self.refresh)
        self._tick.start()
        self.refresh()

    # ---- engine plumbing -------------------------------------------------

    def _run(self, args: list[str], on_done=None, stdin: str | None = None):
        proc = QProcess(self)
        self._procs.add(proc)

        def finished(code, _status):
            out = bytes(proc.readAllStandardOutput()).decode(errors="replace")
            err = bytes(proc.readAllStandardError()).decode(errors="replace")
            self._procs.discard(proc)
            proc.deleteLater()
            if on_done:
                on_done(code, out, err)

        proc.finished.connect(finished)
        proc.start(self._cmd[0], self._cmd[1:] + args)
        if stdin is not None:
            proc.write(stdin.encode())
            proc.closeWriteChannel()
        return proc

    def _watch_changed_file(self):
        changed = STATE_DIR / "changed"
        if changed.exists() and str(changed) not in self._watcher.files():
            self._watcher.addPath(str(changed))

    def _on_fs_change(self, _path):
        # Editors and the engine replace files; re-add the watch each time.
        self._watch_changed_file()
        # The engine reports progress about once a second while syncing; each
        # refresh starts the engine, so refresh at most every 2 seconds.
        wait = 2000 - int((time.time() - self._last_refresh) * 1000)
        if wait <= 0:
            self.refresh()
        elif not self._refresh_queued:
            self._refresh_queued = True
            QTimer.singleShot(wait, self._queued_refresh)

    def _queued_refresh(self):
        self._refresh_queued = False
        self.refresh()

    @Slot()
    def refresh(self):
        if self._refreshing:
            return
        self._refreshing = True
        self._last_refresh = time.time()
        pending = {"n": 3}

        def done():
            pending["n"] -= 1
            if pending["n"] == 0:
                self._refreshing = False
                self.changed.emit()
                self._maybe_notify()

        def got_status(code, out, _err):
            if code == 0:
                try:
                    self._status = json.loads(out)
                except json.JSONDecodeError:
                    pass
            done()

        def got_activity(code, out, _err):
            if code == 0:
                try:
                    self._activity = json.loads(out)
                except json.JSONDecodeError:
                    pass
            done()

        def got_review(code, out, _err):
            if code == 0:
                try:
                    self._review = json.loads(out)
                except json.JSONDecodeError:
                    pass
            done()

        self._run(["status", "--json"], got_status)
        self._run(["activity", "--json", "--limit", "60"], got_activity)
        self._run(["review", "--json"], got_review)

    def _maybe_notify(self):
        state = self.state
        if state != self._last_state:
            if state == "login" and self._last_state is not None:
                self.notify.emit("Login needed", "Your saved login stopped working. Open the app to log in again.")
            elif state == "error" and self._last_state not in (None, "error"):
                self.notify.emit("Sync problem", self.lastError or "The last sync had failures.")
            self._last_state = state
        waiting = (self._status.get("spaceWaiting") or {}).get("files", 0)
        if waiting and not getattr(self, "_last_space_waiting", 0):
            self.notify.emit("Your Drive is full", f"{waiting} file(s) are waiting to upload. Free up space on Drive, or add storage.")
        self._last_space_waiting = waiting
        held = self._status.get("massDeleteHeld", 0)
        if held and held != getattr(self, "_last_mass_held", 0):
            self.notify.emit(
                "Many files deleted at once",
                f"{held} files were deleted from your folder. They were not deleted on Drive until you confirm.",
            )
        self._last_mass_held = held
        count = self._status.get("reviewCount", 0)
        if count > self._last_review_count:
            self.notify.emit("Files need a decision", f"{count} file(s) were skipped to protect your local changes.")
        self._last_review_count = count

    # ---- properties for QML ----------------------------------------------

    @Property(str, notify=changed)
    def state(self) -> str:
        """login | setup | syncing | error | attention | ok"""
        s = self._status
        if not s:
            return "syncing"
        last = s.get("lastRun") or {}
        if not s.get("username") or last.get("errorKind") == "auth":
            return "login"
        if s.get("running") or self._syncing:
            return "syncing"
        if not s.get("folders"):
            return "setup"
        if (last.get("error") and last.get("errorKind") != "stopped") or last.get("failures"):
            return "error"
        if s.get("reviewCount") or s.get("massDeleteHeld") or s.get("spaceWaiting"):
            return "attention"
        return "ok"

    @Property(str, notify=changed)
    def stateText(self) -> str:
        s = self._status
        if self.state == "attention" and s.get("spaceWaiting") and not (s.get("reviewCount") or s.get("massDeleteHeld")):
            return "Your Drive is full"
        return {
            "login": "Login needed",
            "setup": "Choose a folder to start",
            "syncing": "Syncing…",
            "error": "The last sync had problems",
            "attention": "Some files need a decision",
            "ok": "Up to date",
        }[self.state]

    @Property(str, notify=changed)
    def username(self) -> str:
        return self._status.get("username") or ""

    @Property(str, notify=changed)
    def folder(self) -> str:
        """My Files' local folder ("" if My Files isn't synced)."""
        return self._status.get("folder") or ""

    @Property("QVariantList", notify=changed)
    def folders(self) -> list:
        """Every synced folder: My Files and those added from this computer."""
        return [
            {
                "id": f["id"],
                "kind": f["kind"],
                "label": f["label"],
                "local": f["local"],
                "pending": not f.get("firstSyncDone"),
                "excludeDefaults": (f.get("excludes") or {}).get("defaults", True),
                "excludeCustom": "\n".join((f.get("excludes") or {}).get("custom", [])),
            }
            for f in self._status.get("folders") or []
        ]

    @Property(str, notify=changed)
    def syncAccount(self) -> str:
        """The account the sync setup belongs to ("" if none yet)."""
        return self._status.get("syncAccount") or ""

    @Property(str, notify=changed)
    def computerName(self) -> str:
        return self._status.get("computerName") or "this computer"

    @Property(str, notify=changed)
    def lastRunText(self) -> str:
        last = self._status.get("lastRun")
        if not last:
            return "Not synced yet"
        when = relative_time(last.get("finishedMs"))
        if last.get("errorKind") == "stopped":
            return f"Last sync stopped by you at {clock_time(last.get('finishedMs'))}"
        if last.get("error"):
            return f"Last sync {when} failed"
        parts = [f"{last.get('downloaded', 0)} downloaded"]
        if last.get("skipped"):
            parts.append(f"{last['skipped']} skipped")
        if last.get("failures"):
            parts.append(f"{last['failures']} failed")
        return f"Last sync {when}: {', '.join(parts)}"

    @Property(str, notify=changed)
    def progressText(self) -> str:
        """While syncing: what has happened so far, and when the last change was."""
        p = self._status.get("progress")
        if not p:
            return ""
        locale = QLocale.system()
        parts = []
        for key, label in (("created", "folders created"), ("uploaded", "uploaded"), ("downloaded", "downloaded"),
                           ("trashedOnDrive", "moved to Drive's trash"), ("trashed", "moved to trash")):
            if p.get(key):
                parts.append(f"{locale.toString(p[key])} {label}")
        text = f"Since {clock_time(p.get('startedMs'))}: " + (", ".join(parts) if parts else "checking for changes")
        if p.get("scanning"):
            text += f"\nChecking {p['scanning']} on Drive… {locale.toString(p.get('scanned', 0))} folders so far"
            return text
        if p.get("lastMs"):
            item = p.get("lastItem", "")
            folder = f"{p['folder']} › " if p.get("folder") and len(self._status.get("folders") or []) > 1 else ""
            text += f"\nLast change {clock_time(p['lastMs'])}: {folder}{item}"
        return text

    @Property(bool, notify=changed)
    def running(self) -> bool:
        return bool(self._status.get("running")) or self._syncing

    @Property(str, notify=changed)
    def lastError(self) -> str:
        return (self._status.get("lastRun") or {}).get("error") or ""

    @Property(str, notify=changed)
    def nextRunText(self) -> str:
        service = self._status.get("service") or {}
        if not service.get("enabled"):
            return "Automatic sync is off"
        return f"Next sync {relative_time(service.get('nextRunMs'), future=True)}"

    @Property(bool, notify=changed)
    def autoSync(self) -> bool:
        return bool((self._status.get("service") or {}).get("enabled"))

    @Property(int, notify=changed)
    def intervalMinutes(self) -> int:
        return (self._status.get("service") or {}).get("intervalMinutes") or 5

    @Property(int, notify=changed)
    def reviewCount(self) -> int:
        return self._status.get("reviewCount", 0)

    @Property("QVariantList", notify=changed)
    def activity(self) -> list:
        return [
            {
                "kind": a["kind"],
                "path": a["path"],
                "folder": a.get("folder") or "",
                "detail": a.get("detail") or "",
                "when": clock_time(a["timeMs"]),
            }
            for a in self._activity
        ]

    @Property("QVariantList", notify=changed)
    def reviewItems(self) -> list:
        items = []
        for r in self._review:
            local, drive = r.get("local"), r.get("drive")
            newer = ""
            if local and drive and abs(local["mtimeMs"] - drive["mtimeMs"]) > 1000:
                newer = "local" if local["mtimeMs"] > drive["mtimeMs"] else "drive"
            local_info, drive_info = describe_version(local), describe_version(drive)
            # Rounded sizes can match for different files (1,528 vs 1,523 bytes
            # are both "1.49 KiB"): show exact bytes when that hides a difference.
            if (
                local and drive and local.get("size") is not None and drive.get("size") is not None
                and local["size"] != drive["size"] and local_info["size"] == drive_info["size"]
            ):
                locale = QLocale.system()
                local_info["size"] = f"{locale.toString(local['size'])} bytes"
                drive_info["size"] = f"{locale.toString(drive['size'])} bytes"
            items.append(
                {
                    "id": r["id"],
                    "path": r["path"],
                    "folder": r.get("folder") or "",
                    "localRoot": r.get("localRoot") or self.folder,
                    "explanation": (
                        "This file was changed on this computer, and a different version was saved to Drive. "
                        "Sync didn't replace your copy."
                        if r["reason"] == "local-edit"
                        else "Your folder already had a file with this name, and Drive has a different file "
                        "with the same name. Sync didn't replace yours."
                    ),
                    "local": local_info,
                    "localMissing": local is None,
                    "drive": drive_info,
                    "newer": newer,
                }
            )
        return items

    @Property(str, notify=changed)
    def busyAction(self) -> str:
        """Non-empty while a settings/review action runs (disables buttons)."""
        return self._busy_action

    @Property(str, notify=loginChanged)
    def loginState(self) -> str:
        return self._login_state

    @Property(str, notify=loginChanged)
    def loginError(self) -> str:
        return self._login_error

    @Property("QStringList", notify=changed)
    def uploadKinds(self) -> list:
        """Kinds of local change automatic runs upload: new, edits, moves, deletes."""
        return list(self._status.get("uploads") or [])

    @Property(str, notify=changed)
    def spaceWaitingText(self) -> str:
        """Non-empty while uploads wait because Drive is full."""
        w = self._status.get("spaceWaiting")
        if not w:
            return ""
        locale = QLocale.system()
        text = f"Your Drive is full: {locale.toString(w['files'])} file(s) ({locale.formattedDataSize(w['bytes'])}) are waiting to upload."
        st = self._status.get("storage")
        if st:
            text += f" ({locale.formattedDataSize(st['used'])} of {locale.formattedDataSize(st['max'])} used.)"
        return text

    @Property(str, notify=changed)
    def storageText(self) -> str:
        st = self._status.get("storage")
        if not st:
            return ""
        locale = QLocale.system()
        return f"Drive storage: {locale.formattedDataSize(st['used'])} of {locale.formattedDataSize(st['max'])} used"

    @Property(int, notify=changed)
    def massDeleteHeld(self) -> int:
        """Files deleted here at once, held back from Drive until confirmed."""
        return self._status.get("massDeleteHeld", 0)

    @Property(bool, notify=changed)
    def uploadsEdits(self) -> bool:
        """True when local edits go up to Drive (changes what "Keep mine" does)."""
        return "edits" in (self._status.get("uploads") or [])

    @Property(str, notify=changed)
    def trashDir(self) -> str:
        """Empty = the desktop trash; otherwise the chosen folder."""
        trash = self._status.get("trash") or {}
        return trash.get("dir", "") if trash.get("kind") == "folder" else ""

    @Property(bool, notify=changed)
    def startAtLogin(self) -> bool:
        return AUTOSTART_FILE.exists()

    # ---- actions ---------------------------------------------------------

    def _action(self, name: str, args: list[str], then=None):
        """Run an engine command that changes things; report failures."""
        self._busy_action = name
        self.changed.emit()

        def done(code, _out, err):
            self._busy_action = ""
            if code != 0:
                self.notify.emit("Something went wrong", err.strip().splitlines()[-1] if err.strip() else name)
            self.refresh()
            if then and code == 0:
                then()

        self._run(args, done)

    @Slot()
    def syncNow(self):
        if self._syncing or self._status.get("running"):
            return
        self._syncing = True
        self.changed.emit()

        def done(_code, _out, _err):
            self._syncing = False
            self.refresh()

        self._run(["mirror"], done)

    @Slot(str)
    def chooseFolder(self, url_or_path: str):
        path = QUrl(url_or_path).toLocalFile() if url_or_path.startswith("file:") else url_or_path
        self._action("folder", ["config", "folder", path], then=self.syncNow)

    @Slot(str, bool)
    def setUploadKind(self, kind: str, enabled: bool):
        kinds = [k for k in ("new", "edits", "moves", "deletes") if (k == kind and enabled) or (k != kind and k in self.uploadKinds)]
        self._action("uploads", ["config", "uploads", *kinds] if kinds else ["config", "uploads", "none"])

    @Slot()
    def confirmMassDelete(self):
        self._action("deletes", ["push", "deletes", "--allow-many", "--yes"])

    @Slot()
    def restoreDeleted(self):
        self._action("restore", ["restore-deleted"])

    @Slot(str)
    def setTrash(self, url_or_path: str):
        """'desktop', or a folder (path or file: URL) for copies deleted on Drive."""
        value = QUrl(url_or_path).toLocalFile() if url_or_path.startswith("file:") else url_or_path
        self._action("trash", ["config", "trash", value or "desktop"])

    @Slot(bool, int)
    def setAutoSync(self, enabled: bool, minutes: int):
        if enabled:
            self._action("service", ["service", "install", str(max(1, minutes))])
        else:
            self._action("service", ["service", "uninstall"])

    @Slot(str, str)
    def resolve(self, item_id: str, action: str):
        self._action("resolve", ["resolve", item_id, action])

    @Slot(str, str)
    def openLocalFile(self, local_root: str, rel_path: str):
        """Open the local copy of a review item in its default app."""
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(Path(local_root) / rel_path)))

    @Slot(str)
    def openPath(self, local: str):
        QDesktopServices.openUrl(QUrl.fromLocalFile(local))

    @Slot()
    def stopSync(self):
        """Stop the running sync safely (it finishes or cancels the current step)."""
        self._action("stop", ["stop"])

    @Slot(str)
    def addFolder(self, url_or_path: str):
        """Measure a folder first; the UI asks before actually adding it."""
        path = QUrl(url_or_path).toLocalFile() if url_or_path.startswith("file:") else url_or_path
        self._busy_action = "measure"
        self.changed.emit()

        def measured(code, out, err):
            self._busy_action = ""
            self.changed.emit()
            if code != 0:
                self.notify.emit("Can't add that folder", err.strip().splitlines()[-1] if err.strip() else path)
                return
            m = json.loads(out)
            locale = QLocale.system()
            size = lambda n: locale.formattedDataSize(n)
            text = f"{path}\n\n{locale.toString(m['files'])} files ({size(m['bytes'])})."
            if m["includedFiles"] != m["files"]:
                text += (f"\nAfter skipping node_modules, .git, caches and similar: "
                         f"{locale.toString(m['includedFiles'])} files ({size(m['includedBytes'])}).")
            self.folderMeasured.emit(path, text)

        self._run(["folders", "measure", path, "--json"], measured)

    @Slot(str)
    def addFolderConfirmed(self, path: str):
        """Sync a folder from this computer (it appears under Computers on Drive)."""
        self._action("folders", ["folders", "add", path, "--yes"], then=self.syncNow)

    @Slot(str, bool, str)
    def setExcludes(self, folder_id: str, defaults: bool, custom_text: str):
        patterns = [line.strip() for line in custom_text.splitlines() if line.strip()]
        self._action("excludes", ["folders", "excludes", folder_id, "--defaults", "on" if defaults else "off", "--set", *patterns])

    @Slot(str)
    def removeFolder(self, folder_id: str):
        self._action("folders", ["folders", "remove", folder_id])

    @Slot()
    def openFolder(self):
        if self.folder:
            QDesktopServices.openUrl(QUrl.fromLocalFile(self.folder))

    @Slot(bool)
    def setStartAtLogin(self, enabled: bool):
        if enabled:
            AUTOSTART_FILE.parent.mkdir(parents=True, exist_ok=True)
            AUTOSTART_FILE.write_text(
                "[Desktop Entry]\nType=Application\nName=pdsync\nExec=pdsync-gui --hidden\n"
                "Icon=pdsync\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n"
            )
        else:
            AUTOSTART_FILE.unlink(missing_ok=True)
        self.changed.emit()

    # ---- login -----------------------------------------------------------

    def _set_login(self, state: str, error: str = ""):
        self._login_state = state
        self._login_error = error
        self.loginChanged.emit()

    @Slot(str, str)
    def login(self, username: str, password: str):
        if self._login_proc:
            return
        self._set_login("working")
        proc = QProcess(self)
        self._login_proc = proc
        buffer = {"data": b""}
        login_ok = {"value": False}

        def on_output():
            buffer["data"] += bytes(proc.readAllStandardOutput())
            while b"\n" in buffer["data"]:
                line, buffer["data"] = buffer["data"].split(b"\n", 1)
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if message.get("event") == "need":
                    # A retry carries the reason (e.g. the last code was refused).
                    self._set_login(f"need-{message['what']}", message.get("error", ""))
                elif message.get("event") == "fresh-start":
                    self.notify.emit(
                        "Started fresh for this account",
                        f"Folder pairings for {message.get('previous', 'the previous account')} were forgotten (files stay). "
                        "Choose what to sync; uploads are off until you switch them on.",
                    )
                elif message.get("event") == "ok":
                    self._set_login("idle")
                    login_ok["value"] = True
                elif message.get("event") == "error":
                    self._set_login("idle", message.get("message", "Login failed"))

        def on_finished(_code, _status):
            on_output()
            # Sync right away (so a stale "login needed" clears), but only once
            # the login process is done: it may still be starting fresh.
            if login_ok["value"]:
                QTimer.singleShot(500, lambda: self.folders and self.syncNow())
            if self._login_state not in ("idle",):
                self._set_login("idle", self._login_error or "Login stopped unexpectedly")
            self._login_proc = None
            proc.deleteLater()
            self.refresh()

        proc.readyReadStandardOutput.connect(on_output)
        proc.finished.connect(on_finished)
        proc.start(self._cmd[0], self._cmd[1:] + ["login", "--json"])
        proc.write((json.dumps({"username": username.strip(), "password": password}) + "\n").encode())

    @Slot(str)
    def submitLoginValue(self, value: str):
        """Answer a 2FA code or mailbox-password request."""
        if self._login_proc:
            self._set_login("working")
            self._login_proc.write((json.dumps({"value": value.strip()}) + "\n").encode())

    @Slot()
    def cancelLogin(self):
        if self._login_proc:
            self._login_proc.kill()

    @Slot()
    def logout(self):
        self._action("logout", ["logout"])
