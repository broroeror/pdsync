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
        text: (backend.uploadsEdits
                ? "<b>Keep mine</b> uploads your file as the new version on Drive (the Drive version stays in its version history).  "
                : "<b>Keep mine</b> leaves your file as it is (you'll be asked again if it changes on Drive).  ")
            + "<b>Keep both</b> renames your file to “… (local copy …)” and downloads the Drive version."
        textFormat: Text.StyledText
        wrapMode: Text.WordWrap
        opacity: 0.8
        Layout.fillWidth: true
    }

    Label {
        visible: reviewList.count === 0
        text: "Nothing needs a decision."
        opacity: 0.6
        horizontalAlignment: Text.AlignHCenter
        Layout.fillWidth: true
        Layout.topMargin: 40
    }

    ListView {
        id: reviewList
        clip: true
        spacing: 10
        model: backend.reviewItems
        Layout.fillWidth: true
        Layout.fillHeight: true
        ScrollBar.vertical: ScrollBar {}

        delegate: Frame {
            id: card
            required property var modelData
            width: ListView.view.width - 2

            ColumnLayout {
                anchors.fill: parent
                spacing: 8

                Label {
                    text: card.modelData.path
                    font.bold: true
                    elide: Text.ElideMiddle
                    Layout.fillWidth: true
                }
                Label {
                    text: card.modelData.explanation
                    wrapMode: Text.WordWrap
                    opacity: 0.8
                    Layout.fillWidth: true
                }

                RowLayout {
                    spacing: 10
                    Layout.fillWidth: true
                    VersionBox {
                        title: "On this computer"
                        info: card.modelData.local
                        missingText: card.modelData.localMissing ? "Not in the folder any more" : ""
                        newer: card.modelData.newer === "local"
                        actionText: card.modelData.localMissing ? "" : "Open"
                        onAction: backend.openLocalFile(card.modelData.path)
                    }
                    VersionBox {
                        title: "On Drive"
                        info: card.modelData.drive
                        missingText: card.modelData.drive.known ? "" : "Details not available offline"
                        newer: card.modelData.newer === "drive"
                    }
                }

                RowLayout {
                    Layout.fillWidth: true
                    Item { Layout.fillWidth: true }
                    Button {
                        text: "Keep mine"
                        enabled: !backend.busyAction
                        ToolTip.visible: hovered
                        ToolTip.text: backend.uploadsEdits ? "Upload your file as the new version on Drive" : "Leave your file as it is"
                        onClicked: backend.resolve(card.modelData.id, "keep-local")
                    }
                    Button {
                        text: "Keep both"
                        enabled: !backend.busyAction
                        ToolTip.visible: hovered
                        ToolTip.text: "Rename your file aside and download the Drive version"
                        onClicked: backend.resolve(card.modelData.id, "keep-both")
                    }
                }
            }
        }
    }
}
