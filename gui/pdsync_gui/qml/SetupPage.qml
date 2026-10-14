import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
import QtQuick.Layouts

Item {
    ColumnLayout {
        anchors.centerIn: parent
        width: Math.min(parent.width, 420)
        spacing: 14

        Image {
            source: "../icons/pdsync.svg"
            sourceSize: Qt.size(72, 72)
            Layout.alignment: Qt.AlignHCenter
        }
        Label {
            text: "Choose where your files go"
            font.pointSize: 16
            font.bold: true
            Layout.alignment: Qt.AlignHCenter
        }
        Label {
            text: "Logged in as " + backend.username + ". Pick a folder and your Drive's My Files will be copied into it. "
                + "Sync only downloads for now: it never deletes or uploads anything, and never overwrites a file you changed."
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
            Layout.fillWidth: true
        }
        Button {
            text: "Choose folder…"
            highlighted: true
            enabled: !backend.busyAction
            Layout.alignment: Qt.AlignHCenter
            onClicked: dialog.open()
        }
    }

    FolderDialog {
        id: dialog
        title: "Folder for your Drive files"
        onAccepted: backend.chooseFolder(String(selectedFolder))
    }
}
