import SwiftUI
import SwiftData
import FeastCore

struct HistoryView: View {
    @Environment(AppModel.self) private var model
    @Query(sort: \DailyResultCache.dayKey) private var cached: [DailyResultCache]
    @State private var month = DayKey.calendarDate(of: Date(), in: .current)
    @State private var selected: DailyResultCache?
    @State private var loading = false

    private var calendar: Calendar { Calendar.gregorian(in: .current) }

    var body: some View {
        let days = monthDays
        let byKey = Dictionary(uniqueKeysWithValues: cached.map { ($0.dayKey, $0) })
        let inMonth = days.compactMap { $0 }.compactMap { byKey[$0.description] }
        ScrollView {
            VStack(spacing: 16) {
                header
                weekdayRow
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 7), spacing: 6) {
                    ForEach(days.indices, id: \.self) { i in
                        if let key = days[i] {
                            cell(key, byKey[key.description])
                        } else {
                            Color.clear.frame(height: 54)
                        }
                    }
                }
                totals(inMonth)
                if let selected { DayDetailView(day: selected).transition(.opacity) }
            }
            .padding()
        }
        .background(Theme.parchment.ignoresSafeArea())
        .navigationTitle("History")
        .task(id: month.description) { await load() }
        .overlay { if loading && inMonth.isEmpty { ProgressView() } }
    }

    private var header: some View {
        HStack {
            Button { shift(-1) } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Previous month")
            Spacer()
            Text(monthTitle).font(Theme.title(22)).foregroundStyle(Theme.ink)
            Spacer()
            Button { shift(1) } label: { Image(systemName: "chevron.right") }.accessibilityLabel("Next month")
        }
    }

    private var weekdayRow: some View {
        HStack {
            ForEach(calendar.veryShortWeekdaySymbols.indices, id: \.self) { i in
                let idx = (i + calendar.firstWeekday - 1) % 7
                Text(calendar.veryShortWeekdaySymbols[idx]).font(.caption).foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    private func cell(_ key: DayKey, _ day: DailyResultCache?) -> some View {
        let color: Color = switch day?.result {
        case .feast: Theme.safe
        case .missed: Theme.missed
        default: Theme.muted.opacity(0.25)
        }
        return Button {
            selected = day
        } label: {
            VStack(spacing: 3) {
                Text("\(key.day)").font(.footnote.monospacedDigit()).foregroundStyle(Theme.ink)
                Circle().fill(day?.result == nil ? Color.clear : color).frame(width: 10, height: 10)
                    .overlay(Circle().stroke(color, lineWidth: day?.result == nil && (day?.verifiedSeconds ?? 0) > 0 ? 1 : 0))
                Text(day.map { $0.verifiedSeconds > 0 ? "\($0.verifiedSeconds / 60)m" : " " } ?? " ")
                    .font(.system(size: 9).monospacedDigit()).foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity, minHeight: 54)
            .background(key == today ? Theme.card : .clear, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(key == today ? Theme.ink.opacity(0.4) : .clear))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibility(key, day))
    }

    private func totals(_ days: [DailyResultCache]) -> some View {
        let feasts = days.filter { $0.result == .feast }.count
        let missed = days.filter { $0.result == .missed }.count
        let minutes = days.reduce(0) { $0 + $1.verifiedSeconds } / 60
        return HStack {
            stat("\(feasts)", "Feasts", Theme.safe)
            stat("\(missed)", "Missed meals", Theme.missed)
            stat("\(minutes)", "Minutes read", Theme.ink)
        }
        .card()
    }

    private func stat(_ value: String, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text(value).font(Theme.title(22)).foregroundStyle(color)
            Text(label).font(.caption2).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity)
    }

    private func accessibility(_ key: DayKey, _ day: DailyResultCache?) -> String {
        let result = switch day?.result {
        case .feast: "feast"
        case .missed: "missed meal"
        case .pending: "in progress"
        case nil: "no result"
        }
        return "\(key), \(result), \((day?.verifiedSeconds ?? 0) / 60) minutes"
    }

    // MARK: Data

    private var today: DayKey { model.dayModel.dayKey(for: model.now) }

    private var monthTitle: String {
        let date = month.date(hour: 12, in: .current)
        return date.formatted(.dateTime.month(.wide).year())
    }

    /// Days of the visible month, padded with nils so the first lands under its weekday.
    private var monthDays: [DayKey?] {
        let first = DayKey(year: month.year, month: month.month, day: 1)
        let firstDate = first.date(hour: 12, in: .current)
        let weekday = calendar.component(.weekday, from: firstDate)
        let lead = (weekday - calendar.firstWeekday + 7) % 7
        let count = calendar.range(of: .day, in: .month, for: firstDate)?.count ?? 30
        return Array(repeating: nil, count: lead) + (0..<count).map { first.adding(days: $0) }
    }

    private func shift(_ months: Int) {
        let date = calendar.date(byAdding: .month, value: months, to: month.date(hour: 12, in: .current))!
        month = DayKey.calendarDate(of: date, in: .current)
        selected = nil
    }

    private func load() async {
        let first = DayKey(year: month.year, month: month.month, day: 1)
        let last = first.adding(days: 31)
        loading = true
        defer { loading = false }
        guard let history = try? await model.api.history(from: first, to: last) else { return }
        let byKey = Dictionary(uniqueKeysWithValues: cached.map { ($0.dayKey, $0) })
        for d in history.days {
            if let existing = byKey[d.dayKey.description] { existing.update(d) } else { model.context.insert(DailyResultCache(d)) }
        }
        try? model.context.save()
    }
}

struct DayDetailView: View {
    let day: DailyResultCache

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(DayKey(day.dayKey).map { $0.date(hour: 12, in: .current).formatted(date: .complete, time: .omitted) } ?? day.dayKey)
                .font(.headline).foregroundStyle(Theme.ink)
            row("Result", day.result == .feast ? "Feast" : day.result == .missed ? "Missed meal" : "In progress")
            row("Read", "\(day.verifiedSeconds / 60) min \(day.verifiedSeconds % 60) sec")
            if let goal = day.goalSeconds { row("Goal", ScoringDisplay.goalLabel(seconds: goal)) }
            if day.selfReported { row("Reported", "Read outside the app") }
            if let alarm = day.alarmAt { row("Alarm", alarm.formatted(date: .omitted, time: .shortened)) }
        }
        .card()
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(Theme.muted)
            Spacer()
            Text(value).foregroundStyle(Theme.ink)
        }
        .font(.callout)
    }
}
