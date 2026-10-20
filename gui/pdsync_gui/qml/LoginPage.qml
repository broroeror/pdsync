import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Item {
    readonly property bool working: backend.loginState === "working"
    readonly property bool needsCode: backend.loginState === "need-totp"
    readonly property bool needsMailbox: backend.loginState === "need-mailboxPassword"

    ColumnLayout {
        anchors.centerIn: parent
        width: Math.min(parent.width, 380)
        spacing: 12

        Image {
            source: "../icons/pdsync.svg"
            sourceSize: Qt.size(72, 72)
            Layout.alignment: Qt.AlignHCenter
        }
        Label {
            text: backend.username ? "Please log in again" : "Log in to your Drive"
            font.pointSize: 16
            font.bold: true
            Layout.alignment: Qt.AlignHCenter
        }
        Label {
            visible: !!backend.username
            text: "Your saved login stopped working, so syncing is paused."
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
            Layout.fillWidth: true
        }

        // Required by Proton's guidelines wherever credentials are asked for.
        Label {
            text: "This is a third-party application not officially supported by Proton."
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
            opacity: 0.75
            Layout.fillWidth: true
        }

        TextField {
            id: email
            objectName: "emailField"
            placeholderText: "Email or username"
            // Pre-filled once (after an expired login). Not a binding: the app
            // refreshes every few seconds, and a binding would wipe what's typed.
            Component.onCompleted: text = backend.username
            enabled: !working && !needsCode && !needsMailbox
            Layout.fillWidth: true
            onAccepted: password.forceActiveFocus()
        }
        Label {
            text: "Made your account with another email (like Gmail)? Use that email here."
            font.pointSize: 8.5
            opacity: 0.7
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
        }
        TextField {
            id: password
            placeholderText: "Password"
            echoMode: TextInput.Password
            enabled: !working && !needsCode && !needsMailbox
            Layout.fillWidth: true
            onAccepted: logIn.clicked()
        }
        TextField {
            id: extra
            visible: needsCode || needsMailbox
            placeholderText: needsCode ? "6-digit code from your authenticator app" : "Mailbox password"
            echoMode: needsMailbox ? TextInput.Password : TextInput.Normal
            inputMethodHints: needsCode ? Qt.ImhDigitsOnly : Qt.ImhNone
            Layout.fillWidth: true
            onVisibleChanged: if (visible) forceActiveFocus()
            onAccepted: logIn.clicked()
        }

        Label {
            visible: !!backend.loginError
            text: backend.loginError
            color: "#d64545"
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
        }

        RowLayout {
            Layout.fillWidth: true
            BusyIndicator {
                running: working
                visible: working
                Layout.preferredHeight: 28
                Layout.preferredWidth: 28
            }
            Item { Layout.fillWidth: true }
            Button {
                text: "Cancel"
                visible: working || needsCode || needsMailbox
                onClicked: backend.cancelLogin()
            }
            Button {
                id: logIn
                text: needsCode || needsMailbox ? "Continue" : "Log in"
                highlighted: true
                enabled: !working && (needsCode || needsMailbox ? extra.text.length > 0 : email.text.length > 0 && password.text.length > 0)
                onClicked: {
                    if (needsCode || needsMailbox) {
                        backend.submitLoginValue(extra.text)
                        extra.text = ""
                    } else {
                        backend.login(email.text, password.text)
                        password.text = ""
                    }
                }
            }
        }
    }
}
