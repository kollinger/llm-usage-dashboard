import QtQuick
import QtTest
import org.kde.kirigami as Kirigami
import "../../dist/plasma/package/contents/ui" as Native
import "../../dist/plasma/Fixtures.js" as Fixtures
import "../../dist/plasma/package/contents/code/ProviderColors.js" as ProviderColors

TestCase {
    id: test
    name: "PlasmaAccountView"
    width: 780
    height: 840
    visible: true
    when: windowShown
    Native.AccountView {
        id: accountView
        anchors.fill: parent
        onPreferencesChanged: function(favorites, accountView, provider, scale) {
            this.favorites = favorites; this.accountView = accountView; this.provider = provider; this.textScale = scale;
        }
    }
    function init() {
        test.width = 780; test.height = 840;
        accountView.language = "en"; accountView.connectionStatus = "ready";
        accountView.favorites = []; accountView.accountView = "all"; accountView.provider = "all"; accountView.textScale = 1;
        accountView.snapshot = Fixtures.cases[5];
        waitForRendering(accountView);
    }
    function list() { return findChild(accountView, "accountList"); }
    function capture(name) {
        if (Fixtures.screenshots) grabImage(accountView).save(Fixtures.screenshots + "/" + name + ".png");
    }
    function test_counts() {
        [0, 1, 5, 12, 80].forEach(function(count) {
            accountView.snapshot = Fixtures.cases[count];
            tryCompare(list(), "count", Math.min(count, 50));
            wait(80); waitForRendering(accountView);
        });
        verify(findChild(accountView, "accountCount").text.indexOf("50") >= 0);
        verify(list().contentHeight > list().height);
    }
    function test_five_visible() {
        tryCompare(list(), "count", 5);
        waitForRendering(accountView);
        verify(list().contentHeight <= list().height + 1, "Five complete account rows must fit at the default desktop size: " + list().contentHeight + "/" + list().height);
        capture("five-accounts");
        compare(findChild(accountView, "remaining0_0").text, "0.0% left");
        compare(findChild(accountView, "remaining1_1").text, "—");
        compare(findChild(accountView, "quality1_1").text, "Not available");
        verify(findChild(accountView, "accountName1").truncated, "long account name gets a tooltip and separate ordinal");
    }
    function test_filters_favorites() {
        mouseClick(findChild(accountView, "favorite0"));
        compare(accountView.favorites.length, 1);
        mouseClick(findChild(accountView, "favoritesButton"));
        tryCompare(list(), "count", 1);
        mouseClick(findChild(accountView, "favorite0"));
        tryCompare(list(), "count", 0);
        mouseClick(findChild(accountView, "allButton"));
        tryCompare(list(), "count", 5);
        accountView.provider = "gpt";
        tryCompare(list(), "count", 2);
        accountView.provider = "all";
        tryCompare(list(), "count", 5);
    }
    function test_provider_colors() {
        accountView.snapshot = Fixtures.cases.providerColors;
        tryCompare(list(), "count", 9);
        // Synthetic backgrounds exercise the actual theme binding without
        // changing the user's desktop colour scheme or app preferences.
        var original = accountView.Kirigami.Theme.backgroundColor;
        try {
            for (var cycle = 0; cycle < 2; cycle++) {
                ["#eff0f1", "#232629"].forEach(function(background) {
                    accountView.Kirigami.Theme.backgroundColor = background;
                    ["en", "ar"].forEach(function(language) {
                        accountView.language = language;
                        for (var index = 0; index < 9; index++) {
                            list().positionViewAtIndex(index, ListView.Center);
                            wait(30); // Let recycled delegates settle; an unchanged scroll need not produce a new frame.
                            var account = accountView.shown[index];
                            var expected = ProviderColors.quotaAccent(account.provider, background);
                            [0, 1, 2].forEach(function(windowIndex) {
                                var fill = findChild(accountView, "quotaFill" + index + "_" + windowIndex);
                                verify(fill !== null, "Loaded native meter for " + account.provider);
                                compare(fill.color.toString(), expected, account.provider + "/" + background);
                            });
                            verify(findChild(accountView, "quality" + index + "_1").text.length > 0);
                            compare(findChild(accountView, "remaining" + index + "_3").text, "—");
                            verify(!findChild(accountView, "quotaMeter" + index + "_3").visible);
                            compare(findChild(accountView, "quotaMeter" + index + "_2").value, 0);
                        }
                        list().positionViewAtBeginning();
                    });
                });
            }
        } finally { accountView.Kirigami.Theme.backgroundColor = original; }
    }
    function test_resize_scale_rtl() {
        accountView.language = "de";
        for (var cycle = 0; cycle < 2; cycle++) {
            test.width = 320; test.height = 340; accountView.textScale = 1.3;
            wait(80); waitForRendering(accountView);
            verify(list().width <= test.width);
            verify(list().height > 0);
            verify(list().contentHeight > list().height);
            test.width = 780; test.height = 840; accountView.textScale = 1;
            waitForRendering(accountView);
            verify(list().contentHeight <= list().height + 1);
        }
        capture("german-five");
        accountView.language = "ar"; accountView.textScale = 1.3; test.width = 560;
        waitForRendering(accountView);
        verify(accountView.rtl);
        verify(findChild(accountView, "accountCount").text.indexOf("حساب") >= 0);
        capture("arabic-scaled");
    }
    function test_panel_popup() {
        // The shell uses 560x680 for panels. At large text sizes the account
        // grid changes columns; all rows must remain reachable by scrolling.
        test.height = 680;
        accountView.language = "de";
        accountView.snapshot = Fixtures.cases[12];
        for (var cycle = 0; cycle < 2; cycle++) {
            [320, 519, 520, 560].forEach(function(width) {
                test.width = width;
                accountView.textScale = width === 560 ? 1.3 : 1;
                waitForRendering(accountView);
                verify(list().width > 0 && list().width <= width);
                verify(list().height > 0 && list().height < test.height);
                verify(list().contentHeight > list().height);
                list().positionViewAtEnd();
                waitForRendering(accountView);
                verify(list().contentY > 0, "Overflow accounts must be reachable");
                list().positionViewAtBeginning();
                tryCompare(list(), "contentY", 0);
            });
        }
        mouseClick(findChild(accountView, "favorite0"));
        var favorites = accountView.favorites.slice();
        test.width = 780; test.height = 840;
        test.width = 560; test.height = 680;
        compare(accountView.favorites[0], favorites[0], "Changing representation size preserves preferences");
        capture("panel-german-scaled");
        accountView.language = "ar";
        waitForRendering(accountView);
        verify(accountView.rtl);
        capture("panel-arabic-scaled");
    }
    function test_connection_states() {
        accountView.connectionStatus = "unavailable";
        tryVerify(function() { return findChild(accountView, "quality0_0").text.indexOf("Stale") >= 0; });
        verify(findChild(accountView, "connectionNotice").visible);
        capture("offline-stale");
        accountView.connectionStatus = "locked"; accountView.snapshot = null;
        tryCompare(list(), "count", 0);
        verify(!findChild(accountView, "accountCount").visible, "missing snapshot must not claim zero accounts");
        accountView.connectionStatus = "ready"; accountView.snapshot = Fixtures.cases[5];
        tryCompare(list(), "count", 5);
        tryCompare(findChild(accountView, "quality0_0"), "text", "Measured");
    }
    function test_claude_local_source() {
        accountView.snapshot = Fixtures.cases.claude;
        tryCompare(list(), "count", 3);
        tryCompare(findChild(accountView, "remaining0_0"), "text", "73.0% left");
        tryCompare(findChild(accountView, "remaining1_0"), "text", "41.0% left");
        tryCompare(findChild(accountView, "remaining2_0"), "text", "0.0% left");
        compare(findChild(accountView, "remaining2_1").text, "—");
        compare(findChild(accountView, "accountSource2").text, "Local source");
        verify(findChild(accountView, "quality0_0").text.indexOf("Stale") >= 0);
        compare(findChild(accountView, "quality2_0").text, "Measured");
        accountView.provider = "gpt";
        tryCompare(list(), "count", 0);
        accountView.provider = "claude";
        tryCompare(list(), "count", 3);
        mouseClick(findChild(accountView, "favorite2"));
        mouseClick(findChild(accountView, "favoritesButton"));
        tryCompare(list(), "count", 1);
        compare(accountView.favorites[0], Fixtures.cases.claude.accounts[2].id);
        for (var cycle = 0; cycle < 2; cycle++) {
            accountView.snapshot = null;
            tryCompare(list(), "count", 0);
            accountView.snapshot = Fixtures.cases.claude;
            tryCompare(list(), "count", 1);
        }
        accountView.accountView = "all";
        tryCompare(list(), "count", 3);
        accountView.language = "de";
        waitForRendering(accountView);
        tryCompare(findChild(accountView, "accountSource0"), "text", "Lokale Quelle");
        verify(list().contentHeight <= list().height + 1);
        capture("claude-local-german");
        accountView.language = "ar"; test.width = 560;
        waitForRendering(accountView);
        verify(accountView.rtl);
        verify(findChild(accountView, "accountSource0").text.length > 0);
        capture("claude-local-arabic");
    }
    function test_claude_quota_scopes() {
        accountView.snapshot = Fixtures.cases.claudeLabels;
        tryCompare(list(), "count", 1);
        var rows = Fixtures.cases.claudeLabels.accounts[0].windows;
        var labels = ["5h", "All models · Week", "Sonnet only · Week", "Fable · Week", "Fable Extended · Week",
                      "Claude Design · Week", rows[6].label + " · Week", "Limit · Week", "Fable Zero · Week"];
        rows.forEach(function(row, index) {
            var label = findChild(accountView, "quotaLabel0_" + index);
            tryVerify(function() { return label.text.replace(/[\u2068\u2069]/g, "") === labels[index]; });
            compare(findChild(accountView, "remaining0_" + index).text,
                    row.remainingPercent === null ? "—" : accountView.t("limits.leftValue", {percent: accountView.number(row.remainingPercent, 1)}));
            compare(findChild(accountView, "quotaReset0_" + index).text,
                    accountView.t("limits.resetPrefix", {time: accountView.date(row.resetsAt)}));
            compare(findChild(accountView, "quotaMeter0_" + index).visible, row.remainingPercent !== null);
            var quality = findChild(accountView, "quality0_" + index).text;
            if (row.status === "stale") verify(quality.indexOf("Stale") >= 0);
            else compare(quality, accountView.t(row.status === "unavailable" ? "widget.unavailable" : "widget.qualityMeasured"));
        });
        ["de", "ar", "fi"].forEach(function(language) {
            accountView.language = language;
            for (var cycle = 0; cycle < 2; cycle++) {
                [320, 539, 540, 541, 560, 780].forEach(function(width) {
                    test.width = width; test.height = width === 780 ? 840 : 680;
                    accountView.textScale = width === 560 ? 1.3 : 1;
                    wait(40); waitForRendering(accountView);
                    rows.forEach(function(row, index) {
                        var label = findChild(accountView, "quotaLabel0_" + index);
                        verify(label.width > 0 && label.paintedWidth <= label.width + 1, "Scope fits its column: " + language + "/" + width);
                        verify(!label.truncated && label.height >= label.paintedHeight, "Full wrapped scope remains readable");
                        compare(label.text, accountView.quotaLabel(row, "claude"));
                    });
                    verify(list().width <= test.width && list().height > 0);
                    list().positionViewAtEnd(); waitForRendering(accountView);
                    verify(list().contentY >= 0);
                    list().positionViewAtBeginning();
                    if (cycle === 1 && (language === "de" && width === 780 || language === "ar" && width === 560))
                        capture("claude-scopes-" + language + "-" + width);
                });
            }
        });
    }
}
