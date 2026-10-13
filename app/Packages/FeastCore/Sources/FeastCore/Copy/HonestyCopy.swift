import Foundation

/// Copy for the "I read today" honesty screen. Light humor, never shaming.
public enum HonestyCopy {
    public static let lines: [String] = [
        "Thou shalt not bear false witness, not even against thine own streak.",
        "The Lord looketh on the heart. So does this button, sort of.",
        "Verily, verily, did you actually read? We trust you. Mostly.",
        "A feast is a feast. A snack you skipped is not.",
        "Honesty is the best policy, and also the only one we have.",
        "Be ye therefore truthful, even as your scriptures are open.",
    ]

    public static func line<G: RandomNumberGenerator>(using generator: inout G) -> String {
        lines.randomElement(using: &generator) ?? lines[0]
    }

    public static let explanation =
        "Reading somewhere else, like Gospel Library or your paper scriptures, counts on the honor system. "
        + "It has to be reported before the alarm goes off."

    public static let reference = "2 Nephi 32:3"
    public static let verse = "Feast upon the words of Christ; for behold, the words of Christ will tell you all things what ye should do."
}
