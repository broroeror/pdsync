"""Typed input must survive the app's refreshes (login email box, interval box).

    QT_QPA_PLATFORM=offscreen QT_QUICK_CONTROLS_STYLE=Fusion python3 tools/check_inputs.py gui
"""
import sys, time
sys.path.insert(0, sys.argv[1])
import shiboken6
from PySide6.QtCore import QObject, QUrl, Slot, QTimer
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuick import QQuickWindow
from PySide6.QtWidgets import QApplication
from pdsync_gui import backend as B
import tempfile
from pathlib import Path

class Fake(B.Backend):
    def __init__(self):
        B.STATE_DIR = Path(tempfile.mkdtemp())
        super().__init__()
    @Slot()
    def refresh(self): pass

app = QApplication([])
fake = Fake()
now = time.time() * 1000
base = {'username': None, 'folders': [{'id': 'myfiles', 'kind': 'myfiles', 'label': 'My Files', 'local': '/x', 'firstSyncDone': True}],
        'folder': '/x', 'firstSyncDone': True, 'computerName': 'pc', 'lastRun': None, 'reviewCount': 0, 'uploads': [],
        'massDeleteHeld': 0, 'trash': {'kind': 'desktop'}, 'service': {'enabled': True, 'intervalMinutes': 5, 'nextRunMs': now}}
fake._status = dict(base)
engine = QQmlApplicationEngine()
engine.rootContext().setContextProperty('backend', fake)
engine.load(QUrl.fromLocalFile(sys.argv[1] + '/pdsync_gui/qml/Main.qml'))
win = shiboken6.wrapInstance(shiboken6.getCppPointer(engine.rootObjects()[0])[0], QQuickWindow)
win.show()
fake.changed.emit()
results = {}
def step1():
    email = win.findChild(QObject, 'emailField')
    email.setProperty('text', 'typed@example.com')
    for _ in range(5): fake.changed.emit()
    results['email'] = email.property('text')
    # log in -> settings page; type into the interval box, refresh
    fake._status = dict(base, username='typed@example.com')
    fake.changed.emit()
    QTimer.singleShot(300, step2)
def step2():
    win.findChild(QObject, 'tabs').setProperty('currentIndex', 2)
    box = win.findChild(QObject, 'intervalBox')
    results['interval_start'] = box.property('value')
    box.setProperty('value', 15); box.setProperty('edited', True)
    for _ in range(5): fake.changed.emit()
    results['interval_after'] = box.property('value')
    app.quit()
QTimer.singleShot(300, step1)
app.exec()
print(results)
ok = results == {'email': 'typed@example.com', 'interval_start': 5, 'interval_after': 15}
print('PASS' if ok else 'FAIL')
