import XCTest

/// Live end-to-end test against a running API server. Skipped unless the runner sets FEAST_E2E=1
/// (`TEST_RUNNER_FEAST_E2E=1 xcodebuild test ...`). Needs E2E_TZ / E2E_ROLLOVER chosen so the first scored
/// day starts within a few minutes (see tools/e2e_timezone.py).
final class LiveEndToEndTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testOnboardReadAndBecomeSafe() throws {
        let env = ProcessInfo.processInfo.environment
        try XCTSkipUnless(env["FEAST_E2E"] == "1", "Set TEST_RUNNER_FEAST_E2E=1 to run against a live server")
        let tz = try XCTUnwrap(env["E2E_TZ"])
        let rollover = try XCTUnwrap(env["E2E_ROLLOVER"])
        let waitSeconds = Double(env["E2E_WAIT_SECONDS"] ?? "0") ?? 0

        let app = XCUIApplication()
        app.launchEnvironment["TZ"] = tz
        app.launchArguments = ["-uiTesting", "-resetIdentity", "-e2eGoal", "45", "-e2eRollover", rollover]
        app.launch()

        // Onboarding against the server.
        let next = app.buttons["onboardingNext"]
        XCTAssertTrue(next.waitForExistence(timeout: 20))
        next.tap(); next.tap(); next.tap()
        allowNotificationsIfAsked()
        XCTAssertTrue(app.buttons["continueReading"].waitForExistence(timeout: 20))
        dismissAlarmSheetIfShown(app)
        attach(app, "1-home-before-first-day")

        // Wait for the first scored day to begin: pull to refresh until Home says "Exposed".
        let deadline = Date().addingTimeInterval(max(waitSeconds, 60) + 120)
        while !app.staticTexts["Exposed"].exists && Date() < deadline {
            sleep(15)
            dismissAlarmSheetIfShown(app)
        }
        XCTAssertTrue(app.staticTexts["Exposed"].exists, "First scored day should have started")
        attach(app, "1b-home-racing")
        app.buttons["continueReading"].tap()

        // Read for ~70 s: turn a page every 7 s (slower than the 3 s pace limit) and tap in between.
        for i in 0..<10 {
            sleep(4)
            app.tap()
            sleep(3)
            if i % 2 == 0 { app.swipeLeft() } else { app.swipeRight() }
        }
        attach(app, "2-reader")

        app.navigationBars.buttons.element(boundBy: 0).tap()
        let safe = app.staticTexts["Safe today"]
        XCTAssertTrue(safe.waitForExistence(timeout: 30), "Home should show Safe after reading past the goal")
        // Pull to refresh so the status comes from the server, not only local unsynced time.
        app.swipeDown()
        sleep(3)
        XCTAssertTrue(app.staticTexts["Safe today"].exists)
        XCTAssertFalse(app.staticTexts["Not yet synced"].exists, "All reading should have synced")
        attach(app, "3-home-safe")
    }

    private func allowNotificationsIfAsked() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 5) { allow.tap() }
    }

    private func dismissAlarmSheetIfShown(_ app: XCUIApplication) {
        if app.staticTexts["alarmMomentTitle"].exists { app.buttons["Done"].tap() }
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
