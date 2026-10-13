import Foundation
import GRDB

public struct Volume: Codable, Sendable, Identifiable, Hashable {
    public var id: Int
    public var slug: String
    public var ldsSlug: String
    public var title: String
    public var sort: Int
}

public struct Book: Codable, Sendable, Identifiable, Hashable {
    public var id: Int
    public var volumeId: Int
    public var slug: String
    public var ldsSlug: String
    public var title: String
    public var fullTitle: String?
    public var heading: String?
    public var sort: Int
    public var chapterCount: Int
}

public struct Chapter: Codable, Sendable, Identifiable, Hashable {
    public var id: Int
    public var bookId: Int
    public var number: Int
    public var reference: String
    public var verseCount: Int
    public var charCount: Int
    public var sort: Int
}

public struct Verse: Codable, Sendable, Identifiable, Hashable {
    public var id: Int
    public var chapterId: Int
    public var number: Int
    public var reference: String
    public var text: String

    public init(id: Int, chapterId: Int, number: Int, reference: String, text: String) {
        self.id = id
        self.chapterId = chapterId
        self.number = number
        self.reference = reference
        self.text = text
    }
}

public struct SearchHit: Codable, Sendable, Identifiable, Hashable {
    public var id: Int
    public var chapterId: Int
    public var reference: String
    public var text: String
}

/// A chapter with its book and volume, for navigation and deep links.
public struct ChapterLocation: Sendable, Hashable {
    public var volume: Volume
    public var book: Book
    public var chapter: Chapter

    /// Opens the same chapter in Gospel Library via its universal link. Linking is allowed; copying is not.
    public var gospelLibraryURL: URL {
        URL(string: "https://www.churchofjesuschrist.org/study/scriptures/\(volume.ldsSlug)/\(book.ldsSlug)/\(chapter.number)?lang=eng")!
    }

    public var title: String {
        book.chapterCount == 1 ? book.title : "\(book.title) \(chapter.number)"
    }

    /// Opaque reference sent with sessions (for history and future reading plans), e.g. `bofm/2-nephi/32`.
    public var contentRef: String { "\(volume.slug)/\(book.slug)/\(chapter.number)" }
}

/// Read-only access to the bundled scripture database.
public final class ScriptureDatabase: Sendable {
    private let queue: DatabaseQueue

    public init(path: String) throws {
        var config = Configuration()
        config.readonly = true
        config.label = "scriptures"
        queue = try DatabaseQueue(path: path, configuration: config)
    }

    /// Opens `scriptures.sqlite` from the given bundle.
    public convenience init(bundle: Bundle = .main) throws {
        guard let path = bundle.path(forResource: "scriptures", ofType: "sqlite") else {
            throw CocoaError(.fileNoSuchFile)
        }
        try self.init(path: path)
    }


    public func volumes() throws -> [Volume] {
        try queue.read { db in
            try Row.fetchAll(db, sql: "SELECT id, slug, lds_slug, title, sort FROM volumes ORDER BY sort")
                .map(Self.volume)
        }
    }

    public func books(volumeId: Int) throws -> [Book] {
        try queue.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM books WHERE volume_id = ? ORDER BY sort", arguments: [volumeId])
                .map(Self.book)
        }
    }

    public func chapters(bookId: Int) throws -> [Chapter] {
        try queue.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM chapters WHERE book_id = ? ORDER BY number", arguments: [bookId])
                .map(Self.chapter)
        }
    }

    public func verses(chapterId: Int) throws -> [Verse] {
        try queue.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM verses WHERE chapter_id = ? ORDER BY number", arguments: [chapterId])
                .map(Self.verse)
        }
    }

    public func location(chapterId: Int) throws -> ChapterLocation? {
        try queue.read { db in
            guard let c = try Row.fetchOne(db, sql: "SELECT * FROM chapters WHERE id = ?", arguments: [chapterId]),
                  let b = try Row.fetchOne(db, sql: "SELECT * FROM books WHERE id = ?", arguments: [c["book_id"] as Int]),
                  let v = try Row.fetchOne(db, sql: "SELECT id, slug, lds_slug, title, sort FROM volumes WHERE id = ?",
                                           arguments: [b["volume_id"] as Int])
            else { return nil }
            return ChapterLocation(volume: Self.volume(v), book: Self.book(b), chapter: Self.chapter(c))
        }
    }

    /// The chapter after `chapterId` in canonical order, crossing book and volume boundaries.
    public func nextChapterId(after chapterId: Int) throws -> Int? {
        try queue.read { db in
            try Int.fetchOne(db, sql: """
                SELECT id FROM chapters WHERE sort > (SELECT sort FROM chapters WHERE id = ?) ORDER BY sort LIMIT 1
                """, arguments: [chapterId])
        }
    }

    public func previousChapterId(before chapterId: Int) throws -> Int? {
        try queue.read { db in
            try Int.fetchOne(db, sql: """
                SELECT id FROM chapters WHERE sort < (SELECT sort FROM chapters WHERE id = ?) ORDER BY sort DESC LIMIT 1
                """, arguments: [chapterId])
        }
    }

    public func firstChapterId() throws -> Int? {
        try queue.read { db in try Int.fetchOne(db, sql: "SELECT id FROM chapters ORDER BY sort LIMIT 1") }
    }

    /// First chapter of a volume in canonical order, e.g. 1 Nephi 1 for `book-of-mormon`.
    public func firstChapterId(inVolume slug: String) throws -> Int? {
        try queue.read { db in
            try Int.fetchOne(db, sql: """
                SELECT c.id FROM chapters c JOIN books b ON b.id = c.book_id JOIN volumes v ON v.id = b.volume_id
                WHERE v.slug = ? ORDER BY c.sort LIMIT 1
                """, arguments: [slug])
        }
    }

    /// Full-text search over verse text. Every word must match (as a prefix), best matches first.
    public func search(_ query: String, limit: Int = 100) throws -> [SearchHit] {
        guard let pattern = FTS5Pattern(matchingAllPrefixesIn: query) else { return [] }
        return try queue.read { db in
            try Row.fetchAll(db, sql: """
                SELECT v.id, v.chapter_id, v.reference, v.text
                FROM verses_fts JOIN verses v ON v.id = verses_fts.rowid
                WHERE verses_fts MATCH ? ORDER BY rank LIMIT ?
                """, arguments: [pattern, limit])
                .map { SearchHit(id: $0["id"], chapterId: $0["chapter_id"], reference: $0["reference"], text: $0["text"]) }
        }
    }

    public func metadata() throws -> [String: String] {
        try queue.read { db in
            Dictionary(uniqueKeysWithValues: try Row.fetchAll(db, sql: "SELECT key, value FROM meta")
                .map { ($0["key"] as String, $0["value"] as String) })
        }
    }

    // MARK: Row mapping

    private static func volume(_ r: Row) -> Volume {
        Volume(id: r["id"], slug: r["slug"], ldsSlug: r["lds_slug"], title: r["title"], sort: r["sort"])
    }

    private static func book(_ r: Row) -> Book {
        Book(id: r["id"], volumeId: r["volume_id"], slug: r["slug"], ldsSlug: r["lds_slug"], title: r["title"],
             fullTitle: r["full_title"], heading: r["heading"], sort: r["sort"], chapterCount: r["chapter_count"])
    }

    private static func chapter(_ r: Row) -> Chapter {
        Chapter(id: r["id"], bookId: r["book_id"], number: r["number"], reference: r["reference"],
                verseCount: r["verse_count"], charCount: r["char_count"], sort: r["sort"])
    }

    private static func verse(_ r: Row) -> Verse {
        Verse(id: r["id"], chapterId: r["chapter_id"], number: r["number"], reference: r["reference"], text: r["text"])
    }
}
