import Foundation
import Testing
@testable import FeastScripture

@Suite("Scripture database (fixture)")
struct ScriptureDatabaseTests {
    let db: ScriptureDatabase

    init() throws {
        let url = try #require(Bundle.module.url(forResource: "mini", withExtension: "sqlite"))
        db = try ScriptureDatabase(path: url.path)
    }

    @Test func volumesInCanonicalOrder() throws {
        let v = try db.volumes()
        #expect(v.map(\.slug) == ["old-testament", "new-testament", "book-of-mormon",
                                  "doctrine-and-covenants", "pearl-of-great-price"])
    }

    @Test func doctrineAndCovenantsIsOneBookWithSections() throws {
        let dc = try db.volumes().first { $0.slug == "doctrine-and-covenants" }!
        let books = try db.books(volumeId: dc.id)
        #expect(books.map(\.title) == ["Doctrine and Covenants"])
        #expect(try db.chapters(bookId: books[0].id).map(\.number) == [1, 2])
    }

    @Test func searchFindsTheVerseTheAppIsNamedFor() throws {
        let hits = try db.search("feast words christ")
        #expect(hits.contains { $0.reference == "2 Nephi 32:3" })
        #expect(try db.search("").isEmpty)
    }

    @Test func prefixSearch() throws {
        #expect(try db.search("feas").contains { $0.reference == "2 Nephi 32:3" })
    }

    @Test func navigationCrossesBookAndVolumeBoundaries() throws {
        let first = try #require(try db.firstChapterId())
        #expect(try db.previousChapterId(before: first) == nil)
        var id = first
        var count = 1
        while let next = try db.nextChapterId(after: id) { id = next; count += 1 }
        #expect(count == 10)
    }

    @Test func firstChapterOfAVolume() throws {
        let id = try #require(try db.firstChapterId(inVolume: "book-of-mormon"))
        #expect(try db.location(chapterId: id)?.title == "2 Nephi 31")
        #expect(try db.firstChapterId(inVolume: "nope") == nil)
    }

    @Test func locationBuildsGospelLibraryLink() throws {
        let hit = try #require(try db.search("feast words christ").first { $0.reference == "2 Nephi 32:3" })
        let loc = try #require(try db.location(chapterId: hit.chapterId))
        #expect(loc.title == "2 Nephi 32")
        #expect(loc.contentRef == "book-of-mormon/2-nephi/32")
        #expect(loc.gospelLibraryURL.absoluteString
                == "https://www.churchofjesuschrist.org/study/scriptures/bofm/2-ne/32?lang=eng")
    }

    @Test func versesAreOrdered() throws {
        let hit = try #require(try db.search("feast words christ").first)
        let verses = try db.verses(chapterId: hit.chapterId)
        #expect(verses.map(\.number) == Array(1...verses.count))
    }

    @Test func metadataRecordsTheSource() throws {
        let meta = try db.metadata()
        #expect(meta["schema_version"] == "1")
        #expect(meta["source"]?.contains("public domain") == true)
    }
}
