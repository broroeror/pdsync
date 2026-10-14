import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    spacing: 12

    Label {
        text: "Sync skipped these files instead of overwriting your copy. Nothing is lost whichever you choose."
        wrapMode: Text.WordWrap
        Layout.fillWidth: true
    }
    Label {
        text: "<b>Keep mine</b> leaves your file as it is (you'll be asked again if it changes on Drive).  "
            + "<b>Keep both</b> renames your file to “… (local copy …)” and downloads the Drive version."
        textFormat: Text.StyledText
        wrapMode: Text.WordWrap
        opacity: 0.8
        Layout.fillWidth: true
    }

    Frame {
        Layout.fillWidth: true
        Layout.fillHeight: true
        padding: 0

        Label {
            anchors.centerIn: parent
            visible: reviewList.count === 0
            text: "Nothing needs a decision."
            opacity: 0.6
        }

        ListView {
            id: reviewList
            anchors.fill: parent
            clip: true
            spacing: 2
            model: backend.reviewItems
            ScrollBar.vertical: ScrollBar {}
            delegate: ItemDelegate {
                width: ListView.view.width
                hoverEnabled: false
                contentItem: RowLayout {
                    spacing: 10
                    ColumnLayout {
                        spacing: 2
                        Layout.fillWidth: true
                        Label { text: modelData.path; font.bold: true; elide: Text.ElideMiddle; Layout.fillWidth: true }
                        Label { text: modelData.explanation; wrapMode: Text.WordWrap; opacity: 0.75; Layout.fillWidth: true }
                    }
                    Button {
                        text: "Keep mine"
                        enabled: !backend.busyAction
                        onClicked: backend.resolve(modelData.id, "keep-local")
                    }
                    Button {
                        text: "Keep both"
                        enabled: !backend.busyAction
                        onClicked: backend.resolve(modelData.id, "keep-both")
                    }
                }
            }
        }
    }
}
