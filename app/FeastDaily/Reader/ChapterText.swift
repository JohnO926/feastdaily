import UIKit
import FeastScripture

/// Typography for chapter text, shared by both reader modes and the paginator.
struct ChapterTypography: Equatable {
    var fontSize: CGFloat
    var isDark: Bool

    var bodyFont: UIFont {
        let scaled = UIFontMetrics(forTextStyle: .body).scaledValue(for: fontSize)
        let base = UIFont.systemFont(ofSize: scaled)
        return UIFont(descriptor: base.fontDescriptor.withDesign(.serif) ?? base.fontDescriptor, size: scaled)
    }

    var numberFont: UIFont { .systemFont(ofSize: bodyFont.pointSize * 0.6, weight: .semibold) }

    var inkColor: UIColor { isDark ? UIColor(red: 0.94, green: 0.91, blue: 0.85, alpha: 1) : UIColor(red: 0.17, green: 0.14, blue: 0.11, alpha: 1) }
    var mutedColor: UIColor { isDark ? UIColor(red: 0.66, green: 0.61, blue: 0.54, alpha: 1) : UIColor(red: 0.45, green: 0.40, blue: 0.34, alpha: 1) }

    var paragraphStyle: NSParagraphStyle {
        let p = NSMutableParagraphStyle()
        p.lineSpacing = bodyFont.pointSize * 0.35
        p.paragraphSpacing = bodyFont.pointSize * 0.6
        p.hyphenationFactor = 0.3
        return p
    }

    /// The whole chapter as one attributed string: a heading (if any), then verse number + text per paragraph.
    func attributedChapter(heading: String?, verses: [Verse]) -> NSAttributedString {
        let out = NSMutableAttributedString()
        if let heading, !heading.isEmpty {
            out.append(NSAttributedString(string: heading + "\n", attributes: [
                .font: UIFont.italicSystemFont(ofSize: bodyFont.pointSize * 0.85),
                .foregroundColor: mutedColor,
                .paragraphStyle: paragraphStyle,
            ]))
        }
        for (i, v) in verses.enumerated() {
            out.append(NSAttributedString(string: "\(v.number) ", attributes: [
                .font: numberFont,
                .foregroundColor: mutedColor,
                .baselineOffset: bodyFont.pointSize * 0.3,
                .paragraphStyle: paragraphStyle,
            ]))
            out.append(NSAttributedString(string: v.text + (i == verses.count - 1 ? "" : "\n"), attributes: [
                .font: bodyFont,
                .foregroundColor: inkColor,
                .paragraphStyle: paragraphStyle,
            ]))
        }
        return out
    }
}

/// Splits laid-out text into pages that exactly fill a given size, using the same TextKit setup that draws them.
enum ChapterPaginator {
    static func pages(for text: NSAttributedString, size: CGSize) -> [NSRange] {
        guard size.width > 20, size.height > 20, text.length > 0 else { return [NSRange(location: 0, length: text.length)] }
        let storage = NSTextStorage(attributedString: text)
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        var ranges: [NSRange] = []
        var consumed = 0
        let totalGlyphs = layout.numberOfGlyphs
        while consumed < totalGlyphs, ranges.count < 2_000 {
            let container = NSTextContainer(size: size)
            container.lineFragmentPadding = 0
            layout.addTextContainer(container)
            let glyphs = layout.glyphRange(for: container)
            guard glyphs.length > 0 else { break }
            ranges.append(layout.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil))
            consumed = NSMaxRange(glyphs)
        }
        return ranges.isEmpty ? [NSRange(location: 0, length: text.length)] : ranges
    }
}
