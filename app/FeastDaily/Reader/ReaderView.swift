import SwiftUI
import FeastCore
import FeastScripture

struct ReaderView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL

    @State private var chapterId: Int
    @State private var location: ChapterLocation?
    @State private var verses: [Verse] = []
    @State private var driver: ReadingTimerDriver?
    @State private var showSettings = false

    init(chapterId: Int) {
        _chapterId = State(initialValue: chapterId)
    }

    var body: some View {
        let settings = model.localSettings
        let typography = ChapterTypography(fontSize: settings.fontSize, isDark: colorScheme == .dark)
        ZStack(alignment: .bottom) {
            Theme.parchment.ignoresSafeArea()
            if let location, let driver {
                Group {
                    switch settings.readerMode {
                    case .paginated:
                        PagedReaderView(location: location, verses: verses, typography: typography,
                                        initialPage: initialPage, driver: driver,
                                        onPageChange: savePage, onNextChapter: goNext)
                    case .scroll:
                        ScrollReaderView(location: location, verses: verses, typography: typography,
                                         initialVerse: initialVerse, driver: driver,
                                         onTopVerseChange: saveVerse, onNextChapter: goNext)
                    }
                }
                .id("\(chapterId)-\(settings.readerModeRaw)")
                timerBadge
            }
            if driver?.showPrompt == true { StillReadingOverlay(driver: driver!) }
        }
        .navigationTitle(location?.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Menu {
                    Button { goPrevious() } label: { Label("Previous chapter", systemImage: "chevron.left") }
                    Button { goNext() } label: { Label("Next chapter", systemImage: "chevron.right") }
                    if let url = location?.gospelLibraryURL {
                        Button { openURL(url) } label: { Label("Study in Gospel Library", systemImage: "arrow.up.forward.app") }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle").accessibilityLabel("Chapter options")
                }
                Button { showSettings = true } label: {
                    Image(systemName: "textformat.size").accessibilityLabel("Reader settings")
                }
            }
        }
        .sheet(isPresented: $showSettings) { ReaderSettingsSheet() }
        .onAppear {
            load(chapterId)
            if driver == nil {
                driver = ReadingTimerDriver(model: model, initialPageChars: min(location?.chapter.charCount ?? 1_200, 1_200))
            }
            driver?.readerAppeared(contentRef: location?.contentRef)
        }
        .onDisappear { driver?.readerDisappeared() }
        .onChange(of: scenePhase) { _, phase in driver?.scenePhaseChanged(active: phase == .active) }
    }

    private var timerBadge: some View {
        let d = model.display
        return HStack(spacing: 8) {
            Circle().fill(Theme.color(for: d.status)).frame(width: 8, height: 8)
            Text("\(ScoringDisplay.durationLabel(seconds: d.verifiedSeconds)) of \(ScoringDisplay.goalLabel(seconds: d.goalSeconds))")
                .font(.caption.monospacedDigit())
            if d.status == .safe { Text("Safe").font(.caption.bold()).foregroundStyle(Theme.safe) }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.bottom, 6)
        .accessibilityIdentifier("readerTimer")
        .allowsHitTesting(false)
    }

    private var initialPage: Int {
        model.readingPosition?.chapterId == chapterId ? model.readingPosition?.pageIndex ?? 0 : 0
    }

    private var initialVerse: Int {
        model.readingPosition?.chapterId == chapterId ? model.readingPosition?.verseNumber ?? 1 : 1
    }

    private func load(_ id: Int) {
        location = try? model.scripture?.location(chapterId: id)
        verses = (try? model.scripture?.verses(chapterId: id)) ?? []
        if model.readingPosition?.chapterId != id { model.savePosition(chapterId: id, pageIndex: 0, verseNumber: 1) }
    }

    private func goNext() { move(to: try? model.scripture?.nextChapterId(after: chapterId)) }
    private func goPrevious() { move(to: try? model.scripture?.previousChapterId(before: chapterId)) }

    private func move(to id: Int??) {
        guard let next = id ?? nil else { return }
        chapterId = next
        load(next)
        driver?.chapterChanged(contentRef: location?.contentRef, pageChars: min(location?.chapter.charCount ?? 1_200, 1_200))
    }

    private func savePage(_ page: Int) { model.savePosition(chapterId: chapterId, pageIndex: page, verseNumber: 1) }
    private func saveVerse(_ verse: Int) { model.savePosition(chapterId: chapterId, pageIndex: 0, verseNumber: verse) }
}

// MARK: - Paginated

struct PagedReaderView: View {
    let location: ChapterLocation
    let verses: [Verse]
    let typography: ChapterTypography
    let initialPage: Int
    let driver: ReadingTimerDriver
    let onPageChange: (Int) -> Void
    let onNextChapter: () -> Void

    @State private var pages: [NSRange] = []
    @State private var text = NSAttributedString()
    @State private var page: Int?
    @State private var layoutKey = ""
    private let inset = EdgeInsets(top: 12, leading: 24, bottom: 44, trailing: 24)

    var body: some View {
        GeometryReader { geo in
            let size = CGSize(width: geo.size.width - inset.leading - inset.trailing,
                              height: geo.size.height - inset.top - inset.bottom)
            TabView(selection: Binding(get: { page ?? 0 }, set: { page = $0 })) {
                ForEach(pages.indices, id: \.self) { i in
                    PageTextView(text: text.attributedSubstring(from: pages[i]))
                        .frame(width: size.width, height: size.height, alignment: .topLeading)
                        .padding(inset)
                        .frame(width: geo.size.width, height: geo.size.height)
                        .contentShape(Rectangle())
                        .onTapGesture { driver.interaction() }
                        .tag(i)
                }
                if !pages.isEmpty {
                    nextChapterPage.frame(width: geo.size.width, height: geo.size.height).tag(pages.count)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .onAppear { paginate(size: size) }
            .onChange(of: size) { _, s in paginate(size: s) }
            .onChange(of: typography) { _, _ in paginate(size: size) }
            .onChange(of: page) { _, p in
                guard let p, p < pages.count else { return }
                driver.pageShown(chars: pages[p].length)
                onPageChange(p)
            }
            .overlay(alignment: .bottomTrailing) {
                if !pages.isEmpty, let p = page, p < pages.count {
                    Text("\(p + 1) / \(pages.count)").font(.caption2).foregroundStyle(Theme.muted)
                        .padding(.trailing, 24).padding(.bottom, 14)
                }
            }
        }
    }

    private var nextChapterPage: some View {
        VStack(spacing: 16) {
            Text("End of \(location.title)").font(Theme.title(22)).foregroundStyle(Theme.ink)
            Button("Next chapter", action: onNextChapter).buttonStyle(.borderedProminent).tint(Theme.ink)
        }
    }

    private func paginate(size: CGSize) {
        let key = "\(size.width)x\(size.height)-\(typography.fontSize)-\(typography.isDark)-\(location.chapter.id)"
        guard key != layoutKey else { return }
        layoutKey = key
        let attributed = typography.attributedChapter(heading: location.chapter.number == 1 ? location.book.heading : nil,
                                                      verses: verses)
        text = attributed
        pages = ChapterPaginator.pages(for: attributed, size: size)
        let target = min(page ?? initialPage, max(0, pages.count - 1))
        page = target
        if target < pages.count { driver.pageShown(chars: pages[target].length) }
    }
}

/// Draws a page with the same TextKit configuration the paginator measured with, so pages never overflow.
struct PageTextView: UIViewRepresentable {
    let text: NSAttributedString

    func makeUIView(context: Context) -> UITextView {
        let v = UITextView()
        v.isEditable = false
        v.isSelectable = false
        v.isScrollEnabled = false
        v.backgroundColor = .clear
        v.textContainerInset = .zero
        v.textContainer.lineFragmentPadding = 0
        v.adjustsFontForContentSizeCategory = false
        v.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        v.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return v
    }

    func updateUIView(_ v: UITextView, context: Context) {
        if v.attributedText != text { v.attributedText = text }
    }

    /// Fill exactly the proposed page size, so text wraps at the width the paginator measured with.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let w = proposal.width, let h = proposal.height else { return nil }
        return CGSize(width: w, height: h)
    }
}

// MARK: - Scroll

struct ScrollReaderView: View {
    let location: ChapterLocation
    let verses: [Verse]
    let typography: ChapterTypography
    let initialVerse: Int
    let driver: ReadingTimerDriver
    let onTopVerseChange: (Int) -> Void
    let onNextChapter: () -> Void

    @State private var topVerse: Int?
    @State private var lastPageVerse = 1
    /// Characters scrolled past since the last "page"; a page is roughly half a screen of new text.
    private let pageChars = 600

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: typography.fontSize * 0.6) {
                if location.chapter.number == 1, let heading = location.book.heading {
                    Text(heading).font(.system(size: typography.fontSize * 0.85, design: .serif).italic())
                        .foregroundStyle(Theme.muted)
                }
                ForEach(verses) { v in
                    (Text("\(v.number) ").font(.system(size: typography.fontSize * 0.6, weight: .semibold))
                        .foregroundColor(Theme.muted).baselineOffset(typography.fontSize * 0.3)
                     + Text(v.text).font(.system(size: typography.fontSize, design: .serif)).foregroundColor(Theme.ink))
                        .lineSpacing(typography.fontSize * 0.35)
                        .id(v.number)
                }
                Button("Next chapter", action: onNextChapter)
                    .buttonStyle(.borderedProminent).tint(Theme.ink)
                    .frame(maxWidth: .infinity).padding(.vertical, 40)
            }
            .scrollTargetLayout()
            .padding(.horizontal, 24)
            .padding(.bottom, 60)
        }
        .scrollPosition(id: $topVerse, anchor: .top)
        .simultaneousGesture(DragGesture(minimumDistance: 4).onChanged { _ in driver.interaction() })
        .onAppear {
            topVerse = initialVerse
            lastPageVerse = initialVerse
            driver.pageShown(chars: min(location.chapter.charCount, pageChars * 2))
        }
        .onChange(of: topVerse) { _, v in
            guard let v else { return }
            onTopVerseChange(v)
            guard v > lastPageVerse else { lastPageVerse = min(lastPageVerse, v); return }
            let passed = verses.filter { $0.number >= lastPageVerse && $0.number < v }.reduce(0) { $0 + $1.text.count }
            if passed >= pageChars {
                driver.pageShown(chars: passed)
                lastPageVerse = v
            }
        }
    }
}

// MARK: - Overlays and settings

struct StillReadingOverlay: View {
    let driver: ReadingTimerDriver

    var body: some View {
        ZStack {
            Color.black.opacity(0.25).ignoresSafeArea()
            VStack(spacing: 14) {
                Text("Still reading?").font(Theme.title(22)).foregroundStyle(Theme.ink)
                Text("The timer paused after a minute without a scroll or tap.")
                    .font(.callout).multilineTextAlignment(.center).foregroundStyle(Theme.muted)
                HStack {
                    Button("I'm done") { driver.answerPrompt(stillReading: false) }
                        .buttonStyle(.bordered)
                    Button("Still reading") { driver.answerPrompt(stillReading: true) }
                        .buttonStyle(.borderedProminent).tint(Theme.ink)
                        .accessibilityIdentifier("stillReading")
                }
            }
            .padding(24)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .padding(32)
        }
    }
}

struct ReaderSettingsSheet: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let settings = model.localSettings
        NavigationStack {
            Form {
                Picker("Layout", selection: Binding(get: { settings.readerMode }, set: { settings.readerMode = $0; save() })) {
                    Text("Pages").tag(LocalSettings.ReaderMode.paginated)
                    Text("Scroll").tag(LocalSettings.ReaderMode.scroll)
                }
                .pickerStyle(.segmented)
                VStack(alignment: .leading) {
                    Text("Text size").font(.caption).foregroundStyle(Theme.muted)
                    HStack {
                        Image(systemName: "textformat.size.smaller")
                        Slider(value: Binding(get: { settings.fontSize }, set: { settings.fontSize = $0; save() }),
                               in: 14...30, step: 1)
                        Image(systemName: "textformat.size.larger")
                    }
                }
                Picker("Appearance", selection: Binding(get: { settings.appearance }, set: { settings.appearance = $0; save() })) {
                    Text("System").tag(LocalSettings.Appearance.system)
                    Text("Light").tag(LocalSettings.Appearance.light)
                    Text("Dark").tag(LocalSettings.Appearance.dark)
                }
            }
            .navigationTitle("Reader")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium])
    }

    private func save() { try? model.context.save() }
}
