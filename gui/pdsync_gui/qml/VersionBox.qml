import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// One side of a review item: where the version lives, when it was last
// modified, its size, and whether it is the newer of the two.
Pane {
    id: box
    property string title
    property var info: ({ known: false, when: "", size: "" })
    property string missingText
    property bool newer: false
    property string actionText
    signal action()

    Layout.fillWidth: true
    Layout.fillHeight: true
    Layout.preferredWidth: 1
    padding: 10

    background: Rectangle {
        radius: 6
        color: Qt.alpha(box.palette.text, 0.05)
        border.width: box.newer ? 1.5 : 1
        border.color: box.newer ? "#2a9d8f" : Qt.alpha(box.palette.text, 0.15)
    }

    ColumnLayout {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: 3

        RowLayout {
            Layout.fillWidth: true
            Label { text: box.title; font.bold: true; Layout.fillWidth: true }
            Rectangle {
                visible: box.newer
                radius: height / 2
                color: "#2a9d8f"
                implicitWidth: newerLabel.implicitWidth + 12
                implicitHeight: newerLabel.implicitHeight + 4
                Label { id: newerLabel; anchors.centerIn: parent; text: "Newer"; color: "white"; font.pointSize: 8 }
            }
        }
        Label {
            visible: box.info.known
            text: "Modified " + box.info.when
            opacity: 0.85
        }
        Label {
            visible: box.info.known && box.info.size !== ""
            text: box.info.size
            opacity: 0.65
        }
        Label {
            visible: !!box.missingText
            text: box.missingText
            opacity: 0.65
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
        }
        Button {
            visible: !!box.actionText
            text: box.actionText
            flat: true
            Layout.alignment: Qt.AlignLeft
            onClicked: box.action()
        }
    }
}
