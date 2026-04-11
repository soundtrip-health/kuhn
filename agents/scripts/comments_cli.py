#!/usr/bin/env python3
"""Simple CLI for filtering comment export JSON files."""

import argparse
import html
import json
import re
from pathlib import Path

from read_sections import parse_document


TOKEN_RE = re.compile(r"[a-z0-9]{3,}")
TAG_RE = re.compile(r"@([A-Za-z0-9._+-]+(?:@[A-Za-z0-9.-]+\.[A-Za-z]{2,})?)")


def _as_text(value):
    if value is None:
        return ""
    return str(value)


def _normalize_text(value):
    text = html.unescape(_as_text(value)).lower()
    return " ".join(text.split())


def _iter_occurrences(text, needle):
    start = 0
    while True:
        idx = text.find(needle, start)
        if idx == -1:
            return
        yield idx
        start = idx + 1


def _section_label(section):
    number = section.get("section_number")
    title = _as_text(section.get("title")).strip()
    if number and title:
        return f"{number} {title}"
    if number:
        return str(number)
    if title:
        return title
    return "[unknown section]"


def _parse_doc_sections(doc_text):
    doc = Path("__comments_cli_doc_tmp.md")
    doc.write_text(doc_text, encoding="utf-8")
    try:
        sections = parse_document(str(doc))
    finally:
        doc.unlink(missing_ok=True)

    lines = doc_text.splitlines(keepends=True)
    line_offsets = [0]
    running = 0
    for line in lines:
        running += len(line)
        line_offsets.append(running)

    prepared = []
    for section in sections:
        start_char = line_offsets[section["start_line"]]
        end_char = line_offsets[section["end_line"]]
        section_text = html.unescape(section["content"])
        tokens = set(TOKEN_RE.findall(section_text.lower()))
        prepared.append(
            {
                "label": _section_label(section),
                "start_char": start_char,
                "end_char": end_char,
                "text": section_text,
                "tokens": tokens,
            }
        )
    return prepared


def _section_index_for_offset(sections, offset):
    for idx, section in enumerate(sections):
        if section["start_char"] <= offset < section["end_char"]:
            return idx
    return None


def assign_section_guesses(comments, doc_text):
    """Attach best-guess section labels using snippet and order heuristics."""
    if not comments:
        return comments

    sections = _parse_doc_sections(doc_text)
    if not sections:
        for comment in comments:
            comment["guessed_section"] = "[unknown section]"
        return comments

    doc_unescaped = html.unescape(doc_text)
    doc_norm = _normalize_text(doc_unescaped)
    prev_idx = None

    for comment in comments:
        snippet = _as_text(comment.get("quotedFileContent", {}).get("value"))
        snippet_norm = _normalize_text(snippet)
        snippet_tokens = set(TOKEN_RE.findall(snippet_norm))
        scores = [0.0] * len(sections)

        # 1) Direct snippet matches in the full document.
        if len(snippet_norm) >= 8:
            hits = list(_iter_occurrences(doc_norm, snippet_norm))
            if hits:
                unique_bonus = 2.0 if len(hits) == 1 else 0.0
                for hit in hits:
                    sec_idx = _section_index_for_offset(sections, hit)
                    if sec_idx is not None:
                        scores[sec_idx] += (6.0 / len(hits)) + unique_bonus

        # 2) Token overlap against each section.
        if snippet_tokens:
            for idx, section in enumerate(sections):
                overlap = len(snippet_tokens & section["tokens"])
                if overlap:
                    scores[idx] += 2.5 * (overlap / max(3, len(snippet_tokens)))

        # 3) List-order continuity: nearby sections are more likely.
        if prev_idx is not None:
            for idx in range(len(sections)):
                distance = abs(idx - prev_idx)
                scores[idx] += max(0.0, 1.5 - (distance * 0.2))

        best_idx = max(range(len(sections)), key=lambda i: scores[i])
        comment["guessed_section"] = sections[best_idx]["label"]
        prev_idx = best_idx

    return comments


def load_comments(path: Path):
    """Load comments from JSON or newline-delimited JSON pages."""
    raw = path.read_text(encoding="utf-8")

    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return list(parsed.get("comments", []))
        if isinstance(parsed, list):
            return parsed
        return []
    except json.JSONDecodeError:
        comments = []
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            page = json.loads(line)
            if isinstance(page, dict):
                page_comments = page.get("comments", [])
                if isinstance(page_comments, list):
                    comments.extend(page_comments)
        return comments


def filter_comments(
    comments, include_resolved=False, author_keyword=None, content_keyword=None
):
    filtered = []
    for comment in comments:
        if not include_resolved and bool(comment.get("resolved", False)):
            continue

        author_name = _as_text(comment.get("author", {}).get("displayName"))
        content = _as_text(comment.get("content"))

        if author_keyword and author_keyword.lower() not in author_name.lower():
            continue
        if content_keyword and content_keyword.lower() not in content.lower():
            continue

        filtered.append(comment)
    return filtered


def _extract_tags(comment):
    content = _as_text(comment.get("content"))
    tags = TAG_RE.findall(content)
    # Normalize to lower-case and deduplicate while preserving encounter order.
    seen = set()
    ordered = []
    for tag in tags:
        norm = tag.lower()
        if norm not in seen:
            seen.add(norm)
            ordered.append(norm)
    return ordered


def group_comments_by_tag(comments):
    grouped = {}
    for comment in comments:
        tags = _extract_tags(comment)
        if not tags:
            grouped.setdefault("none", []).append(comment)
            continue
        for tag in tags:
            grouped.setdefault(tag, []).append(comment)
    grouped.setdefault("none", [])
    return grouped


def _print_comments(comments, show_section=False, start_idx=1):
    for idx, comment in enumerate(comments, start=1):
        display_idx = start_idx + idx - 1
        author = _as_text(comment.get("author", {}).get("displayName")) or "(unknown)"
        content = _as_text(comment.get("content")) or "(no content)"
        created = _as_text(comment.get("createdTime")) or "(no timestamp)"
        status = "resolved" if bool(comment.get("resolved", False)) else "open"
        print(f"{display_idx}. [{status}] {author} @ {created}")
        if show_section:
            print(f"   section: {_as_text(comment.get('guessed_section')) or '[unknown section]'}")
        print(f"   {content}")


def _print_tagged_groups(comments, show_section=False):
    grouped = group_comments_by_tag(comments)
    ordered_tags = sorted(tag for tag in grouped.keys() if tag != "none")
    ordered_tags.append("none")
    total = 0

    for tag in ordered_tags:
        print(f"\n== {tag} ==")
        group = grouped[tag]
        if not group:
            print("(no comments)")
            continue
        _print_comments(group, show_section=show_section, start_idx=1)
        total += len(group)
    return total


def build_parser():
    parser = argparse.ArgumentParser(
        description="Filter comment JSON by resolution state and keyword."
    )
    parser.add_argument("json_file", help="Path to comments JSON export")
    parser.add_argument(
        "--include-resolved",
        action="store_true",
        help="Include resolved comments (default filters them out)",
    )
    parser.add_argument(
        "--author",
        dest="author_keyword",
        help="Case-insensitive substring filter on author display name",
    )
    parser.add_argument(
        "--content",
        dest="content_keyword",
        help="Case-insensitive substring filter on comment content",
    )
    parser.add_argument(
        "--doc",
        dest="doc_path",
        help="Path to full-text markdown draft for heuristic section guessing",
    )
    parser.add_argument(
        "--sort-tagged",
        action="store_true",
        help="Group output into lists by tagged @name/@email plus none",
    )
    return parser


def main():
    args = build_parser().parse_args()
    comments = load_comments(Path(args.json_file))
    filtered = filter_comments(
        comments,
        include_resolved=args.include_resolved,
        author_keyword=args.author_keyword,
        content_keyword=args.content_keyword,
    )
    if args.doc_path:
        doc_text = Path(args.doc_path).read_text(encoding="utf-8")
        filtered = assign_section_guesses(filtered, doc_text)
    if args.sort_tagged:
        total = _print_tagged_groups(filtered, show_section=bool(args.doc_path))
        print(f"\nTotal grouped entries: {total}")
        print(f"Unique comments after filtering: {len(filtered)}")
    else:
        _print_comments(filtered, show_section=bool(args.doc_path))
        print(f"\nTotal: {len(filtered)} comment(s)")


if __name__ == "__main__":
    main()
