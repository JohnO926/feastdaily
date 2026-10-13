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
XCB          := $(shell command -v xcbeautify >/dev/null && echo "| xcbeautify" || echo "")

.PHONY: help db gen build-sim run-sim shot build-device install-device test-core test-app test server-dev server-test clean

help:
	@echo "db             Build the scripture SQLite from the JSON submodule"
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

db:
	python3 -I tools/build_scriptures_db.py tools/data/scriptures-json app/FeastDaily/Resources/scriptures.sqlite --spot-check
	python3 -I tools/build_scriptures_db.py tools/fixtures/mini-scriptures tools/fixtures/mini.sqlite
	cp tools/fixtures/mini.sqlite app/Packages/FeastCore/Tests/FeastScriptureTests/Fixtures/mini.sqlite

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

server-dev:
	cd server && docker compose up -d && npm run dev

server-test:
	cd server && docker compose up -d && npm test && npm run test:db

clean:
	rm -rf $(DERIVED) $(BUILD_ROOT)/FeastCore app/FeastDaily.xcodeproj
