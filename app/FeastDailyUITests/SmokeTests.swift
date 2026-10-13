import XCTest

/// Offline smoke test: launches with an in-memory store and no network, reads a page, opens History.
final class SmokeTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testHomeReaderAndHistory() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTesting", "-skipOnboarding", "-offline"]
        app.launch()

        let continueButton = app.buttons["continueReading"]
        XCTAssertTrue(continueButton.waitForExistence(timeout: 10))
        continueButton.tap()

        let timer = app.staticTexts.matching(identifier: "readerTimer").firstMatch
        XCTAssertTrue(app.otherElements["readerTimer"].waitForExistence(timeout: 5) || timer.waitForExistence(timeout: 5))
        sleep(5)
        app.swipeLeft()
        sleep(2)

        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["History"].tap()
        XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 5))
    }

    func testOnboardingFlow() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTesting", "-offline"]
        app.launch()
        let next = app.buttons["onboardingNext"]
        XCTAssertTrue(next.waitForExistence(timeout: 10))
        next.tap()
        next.tap()
        next.tap()
        XCTAssertTrue(app.buttons["continueReading"].waitForExistence(timeout: 10))
    }
}
