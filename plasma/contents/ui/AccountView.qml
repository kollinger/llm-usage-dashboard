pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls as Controls
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import "../code/Translations.js" as Translations
import "../code/ViewModel.js" as Model
import "../code/ProviderColors.js" as ProviderColors

Item {
    id: view
    property var snapshot: null
    property string connectionStatus: "loading"
    property string language: "en"
    property var favorites: []
    property string accountView: "all"
    property string provider: "all"
    property real textScale: 1
    property double now: Date.now()
    readonly property bool rtl: language === "ar"
    readonly property int textSize: Math.round(13 * textScale)
    readonly property var filtered: Model.accounts(snapshot, provider, accountView, favorites)
    readonly property var shown: filtered.slice(0, 50)
    readonly property var providerOptions: ["all"].concat(Object.keys(Model.providers).filter(function(key) {
        return key === provider || (snapshot && snapshot.accounts.some(function(account) { return account.provider === key; }));
    }))
    signal preferencesChanged(var favorites, string accountView, string provider, real scale)
    signal refreshRequested()
    onSnapshotChanged: migrateFavorites()
    onFavoritesChanged: migrateFavorites()
    LayoutMirroring.enabled: rtl
    LayoutMirroring.childrenInherit: true

    function migrateFavorites() {
        var mapped = Model.canonicalFavorites(snapshot, favorites);
        if (JSON.stringify(mapped) !== JSON.stringify(favorites)) preferencesChanged(mapped, accountView, provider, textScale);
    }

    function t(key, values) {
        var dictionary = Translations.catalog[language] || Translations.catalog.en;
        var result = key.split(".").reduce(function(value, part) { return value && value[part]; }, dictionary);
        if (typeof result !== "string") return key;
        Object.keys(values || {}).forEach(function(name) { result = result.split("{" + name + "}").join(values[name]); });
        return result;
    }
    function number(value, digits) { return Number(value).toLocaleString(Qt.locale(language), "f", digits || 0); }
    function date(value) { return value && isFinite(Date.parse(value)) ? new Date(value).toLocaleString(Qt.locale(language), "dd MMM hh:mm") : t("widget.unavailable"); }
    function quotaLabel(window, provider) {
        if (window.key === "fiveHour" || window.windowMinutes === 300) return t("limits.fiveHour");
        if (window.key === "weekly" || window.key === "allModels" || window.windowMinutes === 10080) {
            var period = t("limits.weekly");
            if (provider !== "claude") return period;
            var scopeKey = window.key === "weekly" || window.key === "allModels" ? "allModels" :
                window.key === "sonnetOnly" ? "sonnetOnly" : window.key === "claudeDesign" ? "claudeDesign" : null;
            var scope = scopeKey ? t("limits." + scopeKey) : window.label || t("limits.default");
            return t("widget.scopedPeriod", {scope: scope, period: period});
        }
        return window.label || (window.windowMinutes ? t("widget.minutes", {minutes: number(window.windowMinutes)}) : t("widget.title"));
    }
    function toggleFavorite(account) {
        preferencesChanged(Model.toggleFavorite(account, favorites), accountView, provider, textScale);
    }

    Timer { interval: 30000; running: true; repeat: true; onTriggered: view.now = Date.now() }
    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 10
        spacing: 6
        Controls.Label { text: view.t("widget.title"); font.bold: true; font.pixelSize: view.textSize + 3; Layout.fillWidth: true; elide: Text.ElideRight }
        RowLayout {
            Layout.fillWidth: true
            Controls.Button {
                objectName: "allButton"
                text: view.t("widget.all"); checkable: true; checked: view.accountView === "all"; font.pixelSize: view.textSize
                onClicked: view.preferencesChanged(view.favorites, "all", view.provider, view.textScale)
            }
            Controls.Button {
                objectName: "favoritesButton"
                text: view.t("widget.favorites"); checkable: true; checked: view.accountView === "favorites"; font.pixelSize: view.textSize
                onClicked: view.preferencesChanged(view.favorites, "favorites", view.provider, view.textScale)
            }
            Item { Layout.fillWidth: true }
            Controls.ToolButton {
                text: "↻"; font.pixelSize: view.textSize + 4
                Accessible.name: view.t("actions.refresh")
                Controls.ToolTip.text: Accessible.name; Controls.ToolTip.visible: hovered
                onClicked: view.refreshRequested()
            }
        }
        RowLayout {
            Layout.fillWidth: true
            Controls.ComboBox {
                objectName: "providerFilter"
                Layout.fillWidth: true; Layout.minimumWidth: 80
                model: view.providerOptions.map(function(key) { return key === "all" ? view.t("widget.allProviders") : Model.providers[key]; })
                currentIndex: Math.max(0, view.providerOptions.indexOf(view.provider))
                font.pixelSize: view.textSize
                Accessible.name: view.t("widget.filters")
                onActivated: view.preferencesChanged(view.favorites, view.accountView, view.providerOptions[currentIndex], view.textScale)
            }
            Controls.ComboBox {
                objectName: "scaleFilter"
                model: ["100%", "115%", "130%"]
                currentIndex: Math.max(0, [1, 1.15, 1.3].indexOf(view.textScale))
                font.pixelSize: view.textSize
                Accessible.name: view.t("widget.textSize")
                onActivated: view.preferencesChanged(view.favorites, view.accountView, view.provider, [1, 1.15, 1.3][currentIndex])
            }
        }
        Controls.Label {
            objectName: "connectionNotice"
            Layout.fillWidth: true
            visible: view.connectionStatus !== "ready"
            text: view.t(view.connectionStatus === "locked" ? "widget.authRequired" : view.connectionStatus === "loading" ? "widget.loading" : "plasma.offline")
            wrapMode: Text.Wrap
            font.pixelSize: view.textSize
            color: Kirigami.Theme.neutralTextColor
        }
        Controls.Label {
            Layout.fillWidth: true
            text: view.t(!view.snapshot ? "plasma.offline" : view.snapshot.accounts.length ? "widget.emptyFiltered" : "widget.empty")
            visible: view.shown.length === 0 && !!view.snapshot
            wrapMode: Text.Wrap; font.pixelSize: view.textSize
        }
        Controls.ScrollView {
            Layout.fillWidth: true; Layout.fillHeight: true
            contentWidth: availableWidth
            clip: true
            ListView {
                id: accountList
                objectName: "accountList"
                model: view.shown
                spacing: 8
                boundsBehavior: Flickable.StopAtBounds
                delegate: Rectangle {
                    id: card
                    required property var modelData
                    required property int index
                    objectName: "accountCard" + index
                    width: accountList.width
                    implicitHeight: cardLayout.implicitHeight + 16
                    color: Kirigami.Theme.alternateBackgroundColor
                    border.color: Kirigami.Theme.disabledTextColor
                    border.width: 1
                    radius: 6
                    ColumnLayout {
                        id: cardLayout
                        anchors.fill: parent; anchors.margins: 8
                        spacing: 4
                        RowLayout {
                            Layout.fillWidth: true; spacing: 4
                            Controls.Label {
                                objectName: "accountName" + card.index
                                Layout.fillWidth: true; Layout.minimumWidth: 20
                                text: card.modelData.label
                                textFormat: Text.PlainText; elide: Text.ElideRight; font.bold: true; font.pixelSize: view.textSize
                                Controls.ToolTip.text: text; Controls.ToolTip.visible: nameHover.hovered
                                HoverHandler { id: nameHover }
                            }
                            Controls.Label {
                                visible: !!card.modelData.labelIndex
                                text: "· " + view.number(card.modelData.labelIndex || 0)
                                font.bold: true; font.pixelSize: view.textSize
                            }
                            Controls.Label {
                                Layout.maximumWidth: card.width * 0.3; elide: Text.ElideRight
                                objectName: "accountSource" + card.index
                                text: (card.modelData.sources || []).indexOf("local") >= 0 ? view.t("widget.localSource") : Model.providers[card.modelData.provider]
                                font.pixelSize: view.textSize
                                color: Kirigami.Theme.textColor
                            }
                            Controls.ToolButton {
                                objectName: "favorite" + card.index
                                text: Model.favorite(card.modelData, view.favorites) ? "★" : "☆"
                                font.pixelSize: view.textSize + 2
                                implicitHeight: 24 * view.textScale
                                Accessible.name: view.t(Model.favorite(card.modelData, view.favorites) ? "widget.removeFavorite" : "widget.addFavorite", {name: card.modelData.label})
                                Controls.ToolTip.text: Accessible.name; Controls.ToolTip.visible: hovered
                                onClicked: view.toggleFavorite(card.modelData)
                            }
                        }
                        Controls.Label {
                            visible: !card.modelData.windows.length
                            text: view.t("widget.noQuota"); font.pixelSize: view.textSize
                        }
                        GridLayout {
                            Layout.fillWidth: true
                            columns: card.width >= 520 * view.textScale ? Math.min(3, Math.max(1, card.modelData.windows.length)) : 1
                            columnSpacing: 18; rowSpacing: 8
                            Repeater {
                                model: card.modelData.windows
                                ColumnLayout {
                                    id: quota
                                    required property var modelData
                                    required property int index
                                    readonly property var remaining: Model.remaining(modelData)
                                    readonly property bool stale: Model.stale(modelData, view.snapshot, view.connectionStatus !== "ready", view.now)
                                    Layout.fillWidth: true; Layout.minimumWidth: 0
                                    spacing: 2
                                    RowLayout {
                                        Layout.fillWidth: true
                                        Controls.Label {
                                            objectName: "quotaLabel" + card.index + "_" + quota.index
                                            text: view.quotaLabel(quota.modelData, card.modelData.provider)
                                            Layout.fillWidth: true; Layout.minimumWidth: 0
                                            wrapMode: Text.Wrap; textFormat: Text.PlainText; font.pixelSize: view.textSize
                                            Controls.ToolTip.text: text; Controls.ToolTip.visible: quotaHover.hovered
                                            HoverHandler { id: quotaHover }
                                        }
                                        Controls.Label {
                                            objectName: "remaining" + card.index + "_" + quota.index
                                            text: quota.remaining === null ? "—" : view.t("limits.leftValue", {percent: view.number(quota.remaining, 1)})
                                            font.bold: true; font.pixelSize: view.textSize
                                        }
                                    }
                                    Controls.ProgressBar {
                                        id: meter
                                        objectName: "quotaMeter" + card.index + "_" + quota.index
                                        Layout.fillWidth: true; from: 0; to: 100; value: quota.remaining === null ? 0 : quota.remaining
                                        Layout.preferredHeight: 6; Layout.minimumHeight: 6; Layout.maximumHeight: 6
                                        clip: true
                                        padding: 0
                                        background: Rectangle { color: Kirigami.Theme.backgroundColor; border.color: Kirigami.Theme.disabledTextColor; radius: 3 }
                                        contentItem: Item {
                                            Rectangle {
                                                objectName: "quotaFill" + card.index + "_" + quota.index
                                                width: parent.width * meter.position; height: parent.height; radius: 3
                                                anchors.left: view.rtl ? undefined : parent.left
                                                anchors.right: view.rtl ? parent.right : undefined
                                                color: ProviderColors.quotaAccent(card.modelData.provider, Kirigami.Theme.backgroundColor.toString())
                                            }
                                        }
                                        visible: quota.remaining !== null
                                        Accessible.name: view.quotaLabel(quota.modelData, card.modelData.provider)
                                    }
                                    Controls.Label {
                                        objectName: "quotaReset" + card.index + "_" + quota.index
                                        Layout.fillWidth: true
                                        text: view.t("limits.resetPrefix", {time: view.date(quota.modelData.resetsAt)})
                                        wrapMode: Text.Wrap; font.pixelSize: view.textSize
                                    }
                                    Controls.Label {
                                        objectName: "quality" + card.index + "_" + quota.index
                                        Layout.fillWidth: true
                                        text: view.t(quota.remaining === null ? "widget.unavailable" : quota.stale ? "widget.stale" :
                                            ({measured: "widget.qualityMeasured", calculated_from_logs: "widget.qualityCalculated", estimated: "widget.qualityEstimated"}[quota.modelData.quality] || "widget.unavailable"), {time: view.date(quota.modelData.measuredAt)})
                                        wrapMode: Text.Wrap; font.pixelSize: view.textSize
                                        color: quota.stale ? Kirigami.Theme.neutralTextColor : Kirigami.Theme.textColor
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        Controls.Label {
            objectName: "accountCount"
            visible: !!view.snapshot
            Layout.fillWidth: true; wrapMode: Text.Wrap; font.pixelSize: view.textSize
            text: view.t("widget.count", {shown: view.number(view.shown.length), total: view.number(view.snapshot ? view.snapshot.accounts.length : 0)}) +
                (view.filtered.length > 50 ? " · " + view.t("plasma.bounded", {count: view.number(50)}) : "")
        }
    }
}
