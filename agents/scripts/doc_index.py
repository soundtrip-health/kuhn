#!/usr/bin/env python3
"""Find Google Docs character indices for editing operations.

This script parses the JSON output from readDocument (format='json')
and provides index lookups without loading the full JSON into the
LLM context window.

Usage:
    # Save readDocument JSON output to a file first, then:

    python doc_index.py <json_file> outline
        → Section headings with their startIndex-endIndex ranges

    python doc_index.py <json_file> section <number>
        → Start/end index of section (e.g., "1.3", "3.4.1")

    python doc_index.py <json_file> find <text>
        → Find paragraph(s) containing <text>, show indices

    python doc_index.py <json_file> end-of-section <number>
        → Index just before the next section heading (insertion point)

    python doc_index.py <json_file> tables
        → List all tables with their startIndex-endIndex ranges

All indices are 1-based, matching Google Docs API conventions.
"""

import json
import re
import sys


def load_doc(json_file: str) -> dict:
    """Load the Google Docs JSON structure from file."""
    with open(json_file) as f:
        data = json.load(f)
    # Handle the array wrapper from MCP tool output
    if isinstance(data, list):
        return json.loads(data[0]["text"])
    return data


def get_body_elements(doc: dict) -> list:
    """Extract body content elements from the doc structure."""
    return doc.get("body", {}).get("content", [])


def extract_paragraph_text(elem: dict) -> str:
    """Extract plain text from a paragraph element."""
    if "paragraph" not in elem:
        return ""
    parts = []
    for el in elem["paragraph"]["elements"]:
        text_run = el.get("textRun", {})
        parts.append(text_run.get("content", ""))
    return "".join(parts)


def get_heading_style(elem: dict) -> str | None:
    """Return the named style type if it's a heading, else None."""
    if "paragraph" not in elem:
        return None
    style = elem["paragraph"].get("paragraphStyle", {})
    named = style.get("namedStyleType", "")
    if named.startswith("HEADING") or named == "TITLE":
        return named
    return None


SECTION_RE = re.compile(r"^(\d+(?:\.\d+)*)\b")


def find_sections(elements: list) -> list[dict]:
    """Find all numbered section headings with their index ranges.

    Returns list of {section_num, title, startIndex, endIndex, heading_style}.
    endIndex is the start of the *next* section at the same or higher level
    (i.e., the full range of the section including subsections).
    """
    headings = []
    for elem in elements:
        text = extract_paragraph_text(elem).strip()
        m = SECTION_RE.match(text)
        if m:
            headings.append({
                "section_num": m.group(1),
                "title": text.rstrip("\n"),
                "startIndex": elem["startIndex"],
                "elem_endIndex": elem["endIndex"],
                "heading_style": get_heading_style(elem),
            })

    def depth(sec: str) -> int:
        return sec.count(".") + 1

    # Compute section end indices (where the section content ends)
    result = []
    for i, h in enumerate(headings):
        d = depth(h["section_num"])
        end_idx = None
        for j in range(i + 1, len(headings)):
            if depth(headings[j]["section_num"]) <= d:
                # Does not start with our prefix — it's a sibling or parent
                if not headings[j]["section_num"].startswith(
                    h["section_num"] + "."
                ):
                    end_idx = headings[j]["startIndex"]
                    break
        result.append({
            "section_num": h["section_num"],
            "title": h["title"],
            "startIndex": h["startIndex"],
            "heading_endIndex": h["elem_endIndex"],
            "section_endIndex": end_idx,  # None = extends to end of doc
        })
    return result


def cmd_outline(elements: list) -> None:
    """Print section outline with index ranges."""
    sections = find_sections(elements)
    print(f"{'Section':<12} {'Start':>7} {'End':>7}  Title")
    print("-" * 72)
    for s in sections:
        d = s["section_num"].count(".")
        indent = "  " * d
        end = str(s["section_endIndex"]) if s["section_endIndex"] else "EOF"
        title_short = s["title"][:50]
        print(
            f"{indent}{s['section_num']:<{12-2*d}} "
            f"{s['startIndex']:>7} {end:>7}  {indent}{title_short}"
        )


def cmd_section(elements: list, section_num: str) -> None:
    """Print index details for a specific section."""
    sections = find_sections(elements)
    section_num = section_num.rstrip(".")
    for s in sections:
        if s["section_num"] == section_num:
            end = s["section_endIndex"] or "EOF (end of document)"
            print(f"Section:        {s['section_num']}")
            print(f"Title:          {s['title']}")
            print(f"Heading start:  {s['startIndex']}")
            print(f"Heading end:    {s['heading_endIndex']}")
            print(f"Section end:    {end}")
            print()
            print("Useful insertion points:")
            print(f"  Before this section:  index {s['startIndex']}")
            print(f"  After heading line:   index {s['heading_endIndex']}")
            if s["section_endIndex"]:
                print(
                    f"  End of section:       index {s['section_endIndex']}"
                )
            return
    print(f"Section '{section_num}' not found.")
    sys.exit(1)


def cmd_find(elements: list, search_text: str) -> None:
    """Find paragraphs containing the search text."""
    found = False
    for elem in elements:
        text = extract_paragraph_text(elem)
        if search_text.lower() in text.lower():
            found = True
            preview = text.strip()[:120]
            print(
                f"startIndex={elem['startIndex']}, "
                f"endIndex={elem['endIndex']}"
            )
            print(f"  text: {preview}")
            print()
    if not found:
        print(f"No paragraphs found containing: '{search_text}'")
        sys.exit(1)


def cmd_end_of_section(elements: list, section_num: str) -> None:
    """Print the insertion index at the end of a section."""
    sections = find_sections(elements)
    section_num = section_num.rstrip(".")
    for s in sections:
        if s["section_num"] == section_num:
            if s["section_endIndex"]:
                print(s["section_endIndex"])
            else:
                # Section extends to end of doc — find last element
                last = elements[-1]
                print(last.get("endIndex", "EOF"))
            return
    print(f"Section '{section_num}' not found.", file=sys.stderr)
    sys.exit(1)


def cmd_tables(elements: list) -> None:
    """List all tables with their index ranges."""
    found = False
    for elem in elements:
        if "table" in elem:
            found = True
            rows = elem["table"].get("rows", 0)
            cols = elem["table"].get("columns", 0)
            print(
                f"Table: startIndex={elem['startIndex']}, "
                f"endIndex={elem['endIndex']}, "
                f"size={rows}x{cols}"
            )
            # Try to show context: what's the paragraph just before?
    if not found:
        print("No tables found in the document.")


def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    json_file = sys.argv[1]
    command = sys.argv[2]

    doc = load_doc(json_file)
    elements = get_body_elements(doc)

    if command == "outline":
        cmd_outline(elements)
    elif command == "section" and len(sys.argv) >= 4:
        cmd_section(elements, sys.argv[3])
    elif command == "find" and len(sys.argv) >= 4:
        cmd_find(elements, " ".join(sys.argv[3:]))
    elif command == "end-of-section" and len(sys.argv) >= 4:
        cmd_end_of_section(elements, sys.argv[3])
    elif command == "tables":
        cmd_tables(elements)
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
