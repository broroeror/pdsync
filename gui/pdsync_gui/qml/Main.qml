import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ApplicationWindow {
    id: window
    title: "pdsync"
    width: 760
    height: 560
    minimumWidth: 520
    minimumHeight: 420

    // Closing hides to the tray; Quit lives in the tray menu.
    onClosing: (close) => {
        close.accepted = false
        window.hide()
    }

    readonly property bool needsLogin: backend.state === "login"
    readonly property bool needsSetup: backend.state === "setup"

    header: TabBar {
        id: tabs
        objectName: "tabs"
        visible: !window.needsLogin && !window.needsSetup
        TabButton { text: "Status" }
        TabButton { text: backend.reviewCount ? `Review (${backend.reviewCount})` : "Review" }
        TabButton { text: "Settings" }
    }

    Loader {
        anchors.fill: parent
        anchors.margins: 16
        sourceComponent: window.needsLogin ? loginPage : window.needsSetup ? setupPage : tabbed
    }

    // Shown after a folder is measured, before it is added.
    Dialog {
        id: confirmAdd
        property string folderPath
        property string summary
        title: "Sync this folder?"
        modal: true
        anchors.centerIn: Overlay.overlay
        width: Math.min(window.width - 40, 520)
        standardButtons: Dialog.Ok | Dialog.Cancel
        Label {
            width: parent.width
            text: confirmAdd.summary + "\n\nIt appears on Drive under Computers → " + backend.computerName
                + ". Files upload on the next sync, if uploading new files is switched on in Settings."
            wrapMode: Text.WordWrap
        }
        onAccepted: backend.addFolderConfirmed(folderPath)
    }
    Connections {
        target: backend
        function onFolderMeasured(folderPath, summary) {
            confirmAdd.folderPath = folderPath
            confirmAdd.summary = summary
            confirmAdd.open()
        }
    }

    Component { id: loginPage; LoginPage {} }
    Component { id: setupPage; SetupPage {} }
    Component {
        id: tabbed
        StackLayout {
            currentIndex: tabs.currentIndex
            StatusPage { onReviewRequested: tabs.currentIndex = 1 }
            ReviewPage {}
            SettingsPage {}
        }
    }
}
