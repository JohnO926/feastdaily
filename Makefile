# Feast Daily build targets. Build output goes outside the iCloud-synced Desktop folder, because iCloud
# tags files with extended attributes that codesign rejects.

export DEVELOPER_DIR ?= /Applications/Xcode.app/Contents/Developer
BUILD_ROOT   ?= $(HOME)/Library/Caches/FeastDaily
DERIVED      := $(BUILD_ROOT)/DerivedData
PROJECT      := app/FeastDaily.xcodeproj
SCHEME       := FeastDaily
SIM_NAME     ?= iPhone 18 Pro
SIM_DEST     := platform=iOS Simulator,name=$(SIM_NAME)
BUNDLE_ID    := com.valiflo.feastdaily
DEVICE_UDID  ?= $(shell sed -n 's/^DEVICE_UDID *= *//p' app/Config/Local.xcconfig 2>/dev/null)
# Ports 3000 and 5433 are taken by other projects on this Mac; server/.env.local matches these.
API_PORT     ?= 3001
FEAST_DB_PORT ?= 5436
export FEAST_DB_PORT
XCB          := $(shell command -v xcbeautify >/dev/null && echo "| xcbeautify" || echo "")

.PHONY: help db contract e2e gen build-sim run-sim shot build-device install-device test-core test-app test server-dev server-test clean

help:
	@echo "db             Build the scripture SQLite from the JSON submodule"
	@echo "contract       Refresh Swift contract fixtures from server/API.md"
	@echo "gen            Generate the Xcode project (XcodeGen)"
	@echo "build-sim      Build for the $(SIM_NAME) simulator"
	@echo "run-sim        Build, install and launch on the simulator"
	@echo "shot           Screenshot the booted simulator into shots/"
	@echo "build-device   Signed build for a physical iPhone (needs DEVELOPMENT_TEAM in Local.xcconfig)"
	@echo "install-device Install and launch on DEVICE_UDID"
	@echo "test-core      Swift package tests (no simulator)"
	@echo "test-app       App unit and UI tests on the simulator"
	@echo "server-dev     Start Postgres and the API dev server"
	@echo "server-test    Backend unit and DB tests"
	@echo "e2e            Live UI test against a running server (API_BASE_URL); waits for a near rollover"

db:
	python3 -I tools/build_scriptures_db.py tools/data/scriptures-json app/FeastDaily/Resources/scriptures.sqlite --spot-check
	python3 -I tools/build_scriptures_db.py tools/fixtures/mini-scriptures tools/fixtures/mini.sqlite
	cp tools/fixtures/mini.sqlite app/Packages/FeastCore/Tests/FeastScriptureTests/Fixtures/mini.sqlite

# Refresh the Swift contract-test fixtures from the examples in server/API.md.
contract:
	python3 -I tools/extract_contract.py server/API.md app/Packages/FeastCore/Tests/FeastCoreTests/Contract

app/Config/Local.xcconfig:
	cp app/Config/Local.example.xcconfig app/Config/Local.xcconfig

gen: app/Config/Local.xcconfig
	cd app && xcodegen generate --quiet

# Simulator builds are signed ad hoc ("Sign to Run Locally"), so no team is needed and entitlements still apply.
build-sim: gen
	set -o pipefail; xcodebuild -project $(PROJECT) -scheme $(SCHEME) -destination '$(SIM_DEST)' \
	  -derivedDataPath $(DERIVED) CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= build $(XCB)

run-sim: build-sim
	xcrun simctl boot "$(SIM_NAME)" 2>/dev/null || true
	open -a Simulator
	xcrun simctl install booted "$(DERIVED)/Build/Products/Debug-iphonesimulator/Feast Daily.app"
	xcrun simctl launch booted $(BUNDLE_ID)

shot:
	mkdir -p shots && xcrun simctl io booted screenshot shots/$$(date +%Y%m%d-%H%M%S).png

build-device: gen
	set -o pipefail; xcodebuild -project $(PROJECT) -scheme $(SCHEME) -destination 'generic/platform=iOS' \
	  -derivedDataPath $(DERIVED) -allowProvisioningUpdates -allowProvisioningDeviceRegistration build $(XCB)

install-device:
	xcrun devicectl device install app --device $(DEVICE_UDID) "$(DERIVED)/Build/Products/Debug-iphoneos/Feast Daily.app"
	xcrun devicectl device process launch --device $(DEVICE_UDID) $(BUNDLE_ID)

test-core:
	cd app/Packages/FeastCore && swift test --scratch-path $(BUILD_ROOT)/FeastCore

test-app: gen
	set -o pipefail; xcodebuild -project $(PROJECT) -scheme $(SCHEME) -destination '$(SIM_DEST)' \
	  -derivedDataPath $(DERIVED) CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= test $(XCB)

test: test-core test-app server-test

# Live end-to-end: onboard a fresh user in a time zone whose rollover is minutes away, read past a 45 s goal,
# and check Home turns Safe from server state. Needs `make server-dev` (or another server) at API_BASE_URL.
e2e: gen
	set -- $$(python3 -I tools/e2e_timezone.py 120 2400); echo "time zone $$1, rollover $$2:00, in $$3 s"; \
	TEST_RUNNER_FEAST_E2E=1 TEST_RUNNER_E2E_TZ=$$1 TEST_RUNNER_E2E_ROLLOVER=$$2 TEST_RUNNER_E2E_WAIT_SECONDS=$$3 \
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -destination '$(SIM_DEST)' -derivedDataPath $(DERIVED) \
	  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= \
	  -only-testing:FeastDailyUITests/LiveEndToEndTests test $(XCB)

server-dev:
	cd server && docker compose up -d && npx next dev -p $(API_PORT)

server-test:
	cd server && docker compose up -d && npm test && npm run test:db

clean:
	rm -rf $(DERIVED) $(BUILD_ROOT)/FeastCore app/FeastDaily.xcodeproj
