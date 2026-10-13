#!/usr/bin/env python3
"""Build the bundled, read-only scripture database from Scriptures in JSON.

Usage:
    python3 -I tools/build_scriptures_db.py <scriptures-json dir> <output.sqlite> [--spot-check]

The source (github.com/bcbooks/scriptures-json) is public domain. It omits
footnotes, chapter summaries and other copyrighted material; this script keeps
it that way. Uses only the Python standard library.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

SCHEMA_VERSION = "1"

# Canonical order and app-facing slugs. `lds_slug` is the volume path segment
# used for Gospel Library deep links (linking is allowed; copying is not).
VOLUMES = [
    ("old-testament", "ot", "The Old Testament"),
    ("new-testament", "nt", "The New Testament"),
    ("book-of-mormon", "bofm", "The Book of Mormon"),
    ("doctrine-and-covenants", "dc-testament", "The Doctrine and Covenants"),
    ("pearl-of-great-price", "pgp", "The Pearl of Great Price"),
]

SCHEMA = """
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE volumes(
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, lds_slug TEXT NOT NULL,
  title TEXT NOT NULL, sort INTEGER NOT NULL);
CREATE TABLE books(
  id INTEGER PRIMARY KEY, volume_id INTEGER NOT NULL REFERENCES volumes(id),
  slug TEXT NOT NULL UNIQUE, lds_slug TEXT NOT NULL, title TEXT NOT NULL,
  full_title TEXT, heading TEXT, sort INTEGER NOT NULL, chapter_count INTEGER NOT NULL);
CREATE TABLE chapters(
  id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES books(id),
  number INTEGER NOT NULL, reference TEXT NOT NULL, verse_count INTEGER NOT NULL,
  char_count INTEGER NOT NULL, sort INTEGER NOT NULL);
CREATE TABLE verses(
  id INTEGER PRIMARY KEY, chapter_id INTEGER NOT NULL REFERENCES chapters(id),
  number INTEGER NOT NULL, reference TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX books_volume ON books(volume_id, sort);
CREATE INDEX chapters_book ON chapters(book_id, number);
CREATE INDEX verses_chapter ON verses(chapter_id, number);
CREATE VIRTUAL TABLE verses_fts USING fts5(
  text, content='verses', content_rowid='id', tokenize='porter unicode61');
"""


def slugify(name: str) -> str:
    s = name.lower().replace("&", "and")
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s


def normalize(volume_file: str, data: dict) -> list[dict]:
    """Return a list of books: {title, full_title, heading, lds_slug, chapters:[{number, reference, verses:[...]}]}."""
    if "sections" in data:  # Doctrine and Covenants: one book, sections as chapters
        return [
            {
                "title": "Doctrine and Covenants",
                "full_title": data.get("title"),
                "heading": None,
                "lds_slug": "dc",
                "chapters": [
                    {"number": int(s["section"]), "reference": s["reference"], "verses": s["verses"]}
                    for s in data["sections"]
                ],
            }
        ]
    books = []
    for b in data["books"]:
        books.append(
            {
                "title": b["book"],
                "full_title": b.get("full_title"),
                "heading": b.get("heading"),
                "lds_slug": b.get("lds_slug") or slugify(b["book"]),
                "chapters": [
                    {"number": int(c["chapter"]), "reference": c["reference"], "verses": c["verses"]}
                    for c in b["chapters"]
                ],
            }
        )
    return books


def build(src_dir: str, out_path: str, volumes=VOLUMES) -> dict:
    if os.path.exists(out_path):
        os.remove(out_path)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    db = sqlite3.connect(out_path)
    db.executescript(SCHEMA)

    versions = {}
    book_id = chapter_id = verse_id = 0
    chapter_sort = 0
    for vsort, (vfile, lds_slug, vtitle) in enumerate(volumes, start=1):
        path = os.path.join(src_dir, vfile + ".json")
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        versions[vfile] = str(data.get("version", ""))
        db.execute(
            "INSERT INTO volumes(id, slug, lds_slug, title, sort) VALUES (?,?,?,?,?)",
            (vsort, vfile, lds_slug, vtitle, vsort),
        )
        for bsort, book in enumerate(normalize(vfile, data), start=1):
            book_id += 1
            slug = slugify(book["title"])
            if vfile == "doctrine-and-covenants":
                slug = "dc"
            db.execute(
                "INSERT INTO books(id, volume_id, slug, lds_slug, title, full_title, heading, sort, chapter_count)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (book_id, vsort, slug, book["lds_slug"], book["title"], book["full_title"],
                 book["heading"], bsort, len(book["chapters"])),
            )
            for ch in book["chapters"]:
                chapter_id += 1
                chapter_sort += 1
                chars = sum(len(v["text"]) for v in ch["verses"])
                db.execute(
                    "INSERT INTO chapters(id, book_id, number, reference, verse_count, char_count, sort)"
                    " VALUES (?,?,?,?,?,?,?)",
                    (chapter_id, book_id, ch["number"], ch["reference"], len(ch["verses"]), chars, chapter_sort),
                )
                for v in ch["verses"]:
                    verse_id += 1
                    db.execute(
                        "INSERT INTO verses(id, chapter_id, number, reference, text) VALUES (?,?,?,?,?)",
                        (verse_id, chapter_id, int(v["verse"]), v["reference"], v["text"]),
                    )

    db.execute("INSERT INTO verses_fts(verses_fts) VALUES('rebuild')")
    meta = {
        "schema_version": SCHEMA_VERSION,
        "source": "github.com/bcbooks/scriptures-json (public domain)",
        "source_versions": json.dumps(versions, sort_keys=True),
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    db.executemany("INSERT INTO meta(key, value) VALUES (?,?)", sorted(meta.items()))
    db.commit()
    db.execute("PRAGMA journal_mode=DELETE")
    db.execute("VACUUM")
    db.close()
    return {"books": book_id, "chapters": chapter_id, "verses": verse_id}


def spot_check(src_dir: str, out_path: str) -> None:
    """Print verses named in the source changelog (the 2013 edition adjustments) for a manual check."""
    readme = open(os.path.join(src_dir, "README.md"), encoding="utf-8").read()
    refs = sorted(set(re.findall(r"^\s*-\s+((?:\d )?[A-Z][A-Za-z&. ]+? \d+:\d+)\s+—", readme, re.M)))
    db = sqlite3.connect(out_path)
    print(f"\nSpot check: {len(refs)} verses changed in the 2013 edition. Compare against the current edition:")
    for ref in refs:
        row = db.execute("SELECT text FROM verses WHERE reference = ?", (ref,)).fetchone()
        print(f"  {ref}: {row[0] if row else '(not found)'}")
    db.close()


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2
    src, out = argv[1], argv[2]
    counts = build(src, out)
    print(f"Wrote {out}: {counts['books']} books, {counts['chapters']} chapters, {counts['verses']} verses")
    if "--spot-check" in argv:
        spot_check(src, out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
