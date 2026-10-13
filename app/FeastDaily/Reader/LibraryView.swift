import SwiftUI
import FeastScripture

struct LibraryView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let volumes = (try? model.scripture?.volumes()) ?? []
        List(volumes) { v in
            NavigationLink(value: Route.volume(v.id)) {
                Text(v.title).font(.system(.body, design: .serif))
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.parchment.ignoresSafeArea())
        .navigationTitle("Standard Works")
        .overlay {
            if model.scripture == nil {
                ContentUnavailableView("Scriptures unavailable", systemImage: "book.closed",
                                       description: Text("The bundled text could not be opened."))
            }
        }
    }
}

struct BookListView: View {
    @Environment(AppModel.self) private var model
    let volumeId: Int

    var body: some View {
        let books = (try? model.scripture?.books(volumeId: volumeId)) ?? []
        let title = ((try? model.scripture?.volumes()) ?? []).first { $0.id == volumeId }?.title ?? ""
        List(books) { b in
            if b.chapterCount == 1, let chapter = (try? model.scripture?.chapters(bookId: b.id))??.first {
                NavigationLink(value: Route.reader(chapterId: chapter.id)) { row(b) }
            } else {
                NavigationLink(value: Route.book(b.id)) { row(b) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.parchment.ignoresSafeArea())
        .navigationTitle(title)
    }

    private func row(_ b: Book) -> some View {
        HStack {
            Text(b.title).font(.system(.body, design: .serif))
            Spacer()
            if b.chapterCount > 1 {
                Text("\(b.chapterCount)").font(.caption).foregroundStyle(Theme.muted)
            }
        }
    }
}

struct ChapterGridView: View {
    @Environment(AppModel.self) private var model
    let bookId: Int

    var body: some View {
        let chapters = (try? model.scripture?.chapters(bookId: bookId)) ?? []
        let title = chapters.first.flatMap { (try? model.scripture?.location(chapterId: $0.id))??.book.title } ?? ""
        let current = model.readingPosition?.chapterId
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 56), spacing: 10)], spacing: 10) {
                ForEach(chapters) { c in
                    NavigationLink(value: Route.reader(chapterId: c.id)) {
                        Text("\(c.number)")
                            .font(.system(.body, design: .serif).monospacedDigit())
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .foregroundStyle(c.id == current ? Theme.parchment : Theme.ink)
                            .background(c.id == current ? Theme.ink : Theme.card,
                                        in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .accessibilityLabel("Chapter \(c.number)")
                }
            }
            .padding()
        }
        .background(Theme.parchment.ignoresSafeArea())
        .navigationTitle(title)
    }
}

struct SearchView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var hits: [SearchHit] = []

    var body: some View {
        List(hits) { hit in
            NavigationLink(value: Route.reader(chapterId: hit.chapterId)) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(hit.reference).font(.headline)
                    Text(hit.text).font(.system(.callout, design: .serif)).lineLimit(3).foregroundStyle(Theme.muted)
                }
            }
        }
        .overlay {
            if hits.isEmpty && !query.isEmpty { ContentUnavailableView.search(text: query) }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.parchment.ignoresSafeArea())
        .navigationTitle("Search")
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Words or phrases")
        .onChange(of: query) { _, q in
            hits = (try? model.scripture?.search(q, limit: 100)) ?? []
        }
    }
}
