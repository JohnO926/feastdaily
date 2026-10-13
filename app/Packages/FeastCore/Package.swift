// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FeastCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "FeastCore", targets: ["FeastCore"]),
        .library(name: "FeastScripture", targets: ["FeastScripture"]),
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "7.0.0"),
    ],
    targets: [
        .target(name: "FeastCore"),
        .target(
            name: "FeastScripture",
            dependencies: ["FeastCore", .product(name: "GRDB", package: "GRDB.swift")]
        ),
        .testTarget(name: "FeastCoreTests", dependencies: ["FeastCore"]),
        .testTarget(
            name: "FeastScriptureTests",
            dependencies: ["FeastScripture"],
            resources: [.copy("Fixtures/mini.sqlite")]
        ),
    ]
)
