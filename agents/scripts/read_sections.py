#!/usr/bin/env python3
"""
read_sections.py — Extract sections from a Markdown document by heading number.

This script parses Markdown files with numbered headings (e.g., "# 1. Introduction",
"## 3.4.1 Statistical Methods") and can:

1. Print the full document outline (all headers with their section numbers)
2. Extract specific sections (and their sub-sections) by number
3. Combine both: show the outline alongside extracted sections

Usage:
    # Print the full outline
    python3 read_sections.py document.md

    # Extract section 3.4 (including all sub-sections like 3.4.1, 3.4.2, etc.)
    python3 read_sections.py document.md 3.4

    # Extract multiple sections
    python3 read_sections.py document.md 2 3.4

    # Print outline AND extract section 3.4
    python3 read_sections.py document.md --outline 3.4

    # Extract section content without headers in output
    python3 read_sections.py document.md --no-headers 3.4

Heading Recognition:
    The script recognizes Markdown headings that start with a number, such as:
    - "# 1. Introduction"
    - "## 3.4 Analysis Methods"
    - "### 3.4.1. Primary Endpoint Analysis"
    - "# 1 Background"  (number without period also works)

    Headings without leading numbers (e.g., "# Introduction") are treated as
    unnumbered sections and appear in the outline as "[unnumbered]". They can
    be extracted by passing their title (or a partial, case-insensitive match):
        python3 read_sections.py document.md "Executive Summary"

Citations (optional):
    List in-text citations in square brackets (excluding [TODO: ...]), match them to a
    BibTeX file, and write a CSV plus a markdown bibliography ordered by first appearance:

        python3 read_sections.py document.md --citations
        python3 read_sections.py document.md --citations my_report.csv --bib references.bib

    Brackets without a four-digit year (e.g. numeric CI ranges) are omitted from the table.
"""

import re
import sys
import argparse
import csv
import unicodedata
from pathlib import Path

TODO_PATTERN = re.compile(r'\[TODO:\s*(.+?)\]')
# In-text citations use a 4-digit year (optional letter suffix for disambiguation).
YEAR_IN_CITATION = re.compile(r'\b((?:19|20)\d{2}[a-z]?)\b', re.IGNORECASE)
MARKDOWN_LINK = re.compile(r'\[[^\]]*\]\([^)]*\)')


def parse_heading(line: str):
    """Parse a Markdown heading line into (level, section_number, title).

    Returns None if the line is not a heading.

    Examples:
        "# 1. Introduction"       -> (1, "1", "Introduction")
        "## 3.4 Analysis Methods" -> (2, "3.4", "Analysis Methods")
        "### 3.4.1. Primary"      -> (3, "3.4.1", "Primary")
        "# 3"                     -> (1, "3", "")
        "# Introduction"          -> (1, None, "Introduction")
    """
    m = re.match(r'^(#{1,6})\s+(.+)$', line.strip())
    if not m:
        return None

    level = len(m.group(1))
    rest = m.group(2).strip()
    # Some Markdown sources escape dots in numbered headings (e.g., "3\. Title").
    # Normalize only numeric escaped dots so heading-number parsing still works.
    rest_for_number_parse = re.sub(r'(?<=\d)\\\.(?=\d|\s|$)', '.', rest)

    # Try to extract a leading section number with title
    # (e.g., "3.4.1 Primary" or "3.4.1. Primary").
    num_match = re.match(r'^(\d+(?:\.\d+)*)\.?\s+(.*)', rest_for_number_parse)
    if num_match:
        section_num = num_match.group(1)
        title = num_match.group(2).strip()
        return (level, section_num, title)

    # Also accept number-only headings like "# 3" or "# 3."
    bare_num_match = re.match(r'^(\d+(?:\.\d+)*)\.?$', rest_for_number_parse)
    if bare_num_match:
        return (level, bare_num_match.group(1), "")

    return (level, None, rest)


def parse_document(filepath: str):
    """Parse a Markdown document into a list of sections.

    Returns a list of dicts:
        {
            "level": int,           # Heading level (1-6)
            "section_number": str,  # e.g., "3.4.1" or None
            "title": str,           # Heading text without the number
            "heading_line": str,    # Full original heading line
            "start_line": int,      # 0-based line index of the heading
            "end_line": int,        # 0-based line index of last content line (exclusive)
            "content": str          # Full section text including heading
        }
    """
    with open(filepath, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    sections = []
    current_section = None

    for i, line in enumerate(lines):
        parsed = parse_heading(line)
        if parsed is not None:
            # Close the previous section
            if current_section is not None:
                current_section['end_line'] = i
                current_section['content'] = ''.join(lines[current_section['start_line']:i])

            current_section = {
                'level': parsed[0],
                'section_number': parsed[1],
                'title': parsed[2],
                'heading_line': line.rstrip(),
                'start_line': i,
                'end_line': None,
                'content': None,
            }
            sections.append(current_section)

    # Close the last section
    if current_section is not None:
        current_section['end_line'] = len(lines)
        current_section['content'] = ''.join(lines[current_section['start_line']:])

    return sections


def get_outline(sections):
    """Generate an outline string from parsed sections."""
    lines = []
    for sec in sections:
        indent = '  ' * (sec['level'] - 1)
        num = sec['section_number'] or '[unnumbered]'
        lines.append(f"{indent}{num}  {sec['title']}")
    return '\n'.join(lines)


def _toc_entry_label(section: dict) -> str:
    """Return TOC display label for a section."""
    if section['section_number']:
        title = section['title'].strip()
        return f"{section['section_number']} {title}".strip()
    return section['title'].strip() or "[unnumbered]"


def _toc_anchor_slug(label: str) -> str:
    """Build a Markdown heading anchor slug from a section label."""
    slug = label.strip().lower()
    slug = re.sub(r'[^\w\s-]', '', slug)
    slug = re.sub(r'[\s_]+', '-', slug)
    slug = re.sub(r'-+', '-', slug).strip('-')
    return slug


def write_toc_markdown(filepath: str, sections) -> Path:
    """Write markdown table of contents to <document-stem>-toc.md."""
    source = Path(filepath)
    output = source.with_name(f"{source.stem}-toc.md")

    lines = [
        '# Table of Contents',
        '',
    ]

    for sec in sections:
        label = _toc_entry_label(sec)
        if label == '[unnumbered]':
            continue
        anchor = _toc_anchor_slug(label)
        if not anchor:
            continue
        # Use &emsp; for visible indentation when rendered as Markdown/HTML.
        indent = '&emsp;' * (sec['level'] - 1)
        lines.append(f"{indent}[{label}](#{anchor})  ")

    lines.append('')
    output.write_text('\n'.join(lines), encoding='utf-8')
    return output


def extract_section(sections, target_number: str):
    """Extract a section and all its sub-sections by section number.

    For example, requesting "3" returns section 3 and all of 3.1, 3.2, 3.2.1, etc.
    Requesting "3.4" returns 3.4 and 3.4.1, 3.4.2, etc. but NOT 3.5.
    """
    results = []
    collecting = False

    for sec in sections:
        num = sec['section_number']
        if num is None:
            if collecting:
                # Unnumbered heading breaks the collection
                # (it's a different structural element)
                collecting = False
            continue

        if num == target_number:
            collecting = True
            results.append(sec)
        elif collecting:
            # Check if this is a sub-section of the target
            if num.startswith(target_number + '.'):
                results.append(sec)
            else:
                collecting = False

    return results


def extract_section_by_title(sections, title_query: str):
    """Extract a section by title (case-insensitive partial match).

    Collects the matching section and all immediately following sub-sections
    (deeper heading levels) until a sibling or ancestor heading is encountered.
    """
    target_idx = None
    for i, sec in enumerate(sections):
        if title_query.lower() in sec['title'].lower():
            target_idx = i
            break

    if target_idx is None:
        return []

    target_level = sections[target_idx]['level']
    results = [sections[target_idx]]

    for sec in sections[target_idx + 1:]:
        if sec['level'] > target_level:
            results.append(sec)
        else:
            break

    return results


def format_sections(extracted_sections, include_headers=True):
    """Format extracted sections into a single string."""
    parts = []
    for sec in extracted_sections:
        if include_headers:
            parts.append(sec['content'])
        else:
            # Strip the heading line from content
            content_lines = sec['content'].split('\n')
            parts.append('\n'.join(content_lines[1:]))
    return '\n'.join(parts)


def get_section_label(section):
    """Return a human-readable section label for reports."""
    if section['section_number']:
        title = section['title'].strip()
        return f"{section['section_number']} {title}".strip()
    return section['title'].strip() or "[unnumbered]"


def collect_todos(sections):
    """Collect embedded TODO markers from parsed sections.

    Expected TODO format: [TODO: do something.]
    """
    todos = []
    for sec in sections:
        for match in TODO_PATTERN.finditer(sec['content']):
            todos.append(
                {
                    'section_label': get_section_label(sec),
                    'todo': match.group(1).strip(),
                }
            )
    return todos


def build_todo_rows(todos):
    """Build CSV rows for TODO export."""
    rows = [["todo #", "TODO", "section", "user directive"]]
    for idx, item in enumerate(todos, 1):
        rows.append([str(idx), item['todo'], item['section_label'], ""])
    return rows


def write_todo_report(filepath: str, sections, output_path: str = None):
    """Write TODO report to disk and return output path + count."""
    todos = collect_todos(sections)
    if output_path is None:
        output = Path(filepath).with_suffix('.todos.csv')
    else:
        output = Path(output_path)

    rows = build_todo_rows(todos)
    with output.open('w', encoding='utf-8', newline='') as f:
        writer = csv.writer(f)
        writer.writerows(rows)
    return output, len(todos)


def _strip_accents(s: str) -> str:
    """ASCII fold for loose author matching (e.g. Hernán vs Hernan)."""
    nfkd = unicodedata.normalize('NFKD', s)
    return ''.join(c for c in nfkd if not unicodedata.combining(c))


def _normalize_token(s: str) -> str:
    s = _strip_accents(s).lower()
    return re.sub(r'[^a-z0-9]+', '', s)


def _first_author_last_name(author_field: str) -> str:
    """Best-effort first-author surname from a BibTeX author = {...} value."""
    if not author_field:
        return ''
    # Drop outer braces for simple cases
    a = author_field.strip()
    if a.startswith('{') and a.endswith('}'):
        inner = a[1:-1]
        if '{' not in inner:
            a = inner
    # Split on ' and ' for multiple authors
    first = re.split(r'\s+and\s+', a, maxsplit=1, flags=re.IGNORECASE)[0].strip()
    if ',' in first:
        return first.split(',')[0].strip()
    parts = first.split()
    return parts[-1] if parts else ''


def _split_bibtex_authors(author_field: str) -> list[str]:
    """Split BibTeX author string on 'and' and normalize display text."""
    if not author_field:
        return []

    # BibTeX separates authors with " and " at top level only. Preserve "and" inside {...}.
    raw_parts: list[str] = []
    buf: list[str] = []
    depth = 0
    i = 0
    s = author_field
    while i < len(s):
        c = s[i]
        if c == '{':
            depth += 1
            buf.append(c)
            i += 1
            continue
        if c == '}':
            depth = max(0, depth - 1)
            buf.append(c)
            i += 1
            continue
        if depth == 0 and s[i : i + 5].lower() == ' and ':
            part = ''.join(buf).strip()
            if part:
                raw_parts.append(part)
            buf = []
            i += 5
            continue
        buf.append(c)
        i += 1

    tail = ''.join(buf).strip()
    if tail:
        raw_parts.append(tail)

    authors = [_clean_bibtex_display(p) for p in raw_parts]
    return [a for a in authors if a]


def _author_to_apa(name: str) -> str:
    """Convert a single BibTeX author name to APA format: Last, I. I.

    Handles both "Last, First Middle" and "First Middle Last" formats.
    Group/institutional names pass through as-is.
    """
    name = name.strip()
    if not name:
        return ''

    # --- Detect institutional / group authors ---
    # Heuristic signals that this is NOT a personal name:
    #   - Contains semicolons (multiple organizational units)
    #   - The "first name" part after a comma has 4+ words (unlikely for a person)
    #   - No comma and many capitalized words or digits
    #   - Contains telltale institutional words
    _INSTITUTIONAL_WORDS = {
        'administration', 'agency', 'association', 'center', 'centre',
        'collaborators', 'commission', 'committee', 'consortium',
        'department', 'division', 'foundation', 'government', 'group',
        'inc', 'inc.', 'institute', 'laboratory', 'ministry', 'network',
        'office', 'organization', 'programme', 'program', 'service',
        'society', 'university', 'working',
    }
    name_lower = name.lower()
    if ';' in name:
        return name
    if any(w in name_lower.split() for w in _INSTITUTIONAL_WORDS):
        return name
    if ',' not in name:
        words = name.split()
        if len(words) >= 3 or any(c.isdigit() for c in name):
            if all(w[0].isupper() or not w[0].isalpha() for w in words):
                return name  # group author
    if ',' in name:
        parts = name.split(',', 1)
        last = parts[0].strip()
        firsts = parts[1].strip()
        # If the "first name" portion has 4+ words, likely institutional
        if len(firsts.split()) >= 4:
            return name
    else:
        words = name.split()
        if len(words) == 1:
            return words[0]
        last = words[-1]
        firsts = ' '.join(words[:-1])
    # Build initials from first/middle names
    initials = []
    for part in firsts.split():
        if part:
            initials.append(f'{part[0]}.')
    return f"{last}, {' '.join(initials)}" if initials else last


def _format_author_list(authors: list[str]) -> str:
    """
    Format authors with commas and one 'and' before the last author.

    Examples:
      ["A"] -> "A"
      ["A", "B"] -> "A and B"
      ["A", "B", "C"] -> "A, B, and C"
    """
    if not authors:
        return ''
    if len(authors) == 1:
        return authors[0]
    if len(authors) == 2:
        return f"{authors[0]} and {authors[1]}"
    return ', '.join(authors[:-1]) + f", and {authors[-1]}"


def _format_author_list_apa(authors: list[str]) -> str:
    """Format a list of already-APA-converted author names per APA 7th rules.

    - 1 author: Last, I. I.
    - 2 authors: Last, I. I., & Last, I. I.
    - 3-20 authors: all listed, & before last
    - 21+ authors: first 19, ..., last author
    """
    if not authors:
        return ''
    if len(authors) == 1:
        return authors[0]
    if len(authors) == 2:
        return f'{authors[0]}, & {authors[1]}'
    if len(authors) <= 20:
        return ', '.join(authors[:-1]) + f', & {authors[-1]}'
    # 21+ authors: first 19 ... last
    return ', '.join(authors[:19]) + ', ... ' + authors[-1]


def _first_author_last_from_author_field(author_field: str) -> str:
    """First-author surname from BibTeX author field after splitting."""
    authors = _split_bibtex_authors(author_field)
    if not authors:
        return ''
    first = authors[0]
    if ',' in first:
        return first.split(',')[0].strip()
    parts = first.split()
    return parts[-1] if parts else ''


def _extract_field_from_entry_body(body: str, field: str) -> str | None:
    """Extract BibTeX field value (brace-balanced); supports nested braces."""
    m = re.search(rf'^\s*{re.escape(field)}\s*=\s*\{{', body, re.MULTILINE | re.IGNORECASE)
    if not m:
        return None
    start = m.end() - 1  # position of opening '{'
    depth = 0
    i = start
    while i < len(body):
        c = body[i]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return body[start + 1 : i]
        i += 1
    return None


def parse_references_bib(path: str) -> list[dict]:
    """Parse .bib using python-bibtexparser and return normalized entry dicts."""
    try:
        import bibtexparser  # type: ignore
    except Exception as exc:
        raise RuntimeError(
            "python-bibtexparser is required for --citations. "
            "Install with: python3 -m pip install 'bibtexparser~=1.0' "
            "(or in your project virtualenv)."
        ) from exc

    entries: list[dict] = []

    def _add_entry(cite_key: str, etype: str, fields: dict):
        year_raw = str(fields.get('year', '') or '')
        year = None
        if year_raw:
            ym = re.search(r'\b((?:19|20)\d{2})\b', year_raw)
            if ym:
                year = int(ym.group(1))
        author = str(fields.get('author', '') or '')
        title = str(fields.get('title', '') or '')
        journal = str(fields.get('journal', '') or fields.get('booktitle', '') or '')
        first_last = _first_author_last_from_author_field(author)
        entries.append(
            {
                'cite_key': cite_key,
                'ENTRYTYPE': etype,
                'year': year,
                'year_raw': year_raw,
                'author': author,
                'title': title,
                'journal': journal,
                'volume': str(fields.get('volume', '') or ''),
                'number': str(fields.get('number', '') or ''),
                'pages': str(fields.get('pages', '') or ''),
                'doi': str(fields.get('doi', '') or ''),
                'first_author_last': first_last,
                'first_author_norm': _normalize_token(first_last),
            }
        )

    # v1-style API
    if hasattr(bibtexparser, 'load'):
        from bibtexparser.bparser import BibTexParser  # type: ignore

        with Path(path).open('r', encoding='utf-8') as bib_file:
            parser = BibTexParser(common_strings=True)
            bib_db = bibtexparser.load(bib_file, parser=parser)
        for e in getattr(bib_db, 'entries', []):
            cite_key = e.get('ID') or e.get('id') or ''
            etype = e.get('ENTRYTYPE') or e.get('entrytype') or 'misc'
            if not cite_key:
                continue
            fields = {k.lower(): v for k, v in e.items()}
            _add_entry(str(cite_key), str(etype), fields)
        return entries

    # v2-style API fallback
    if hasattr(bibtexparser, 'parse_file'):
        bib_db = bibtexparser.parse_file(path)
        for e in getattr(bib_db, 'entries', []):
            cite_key = getattr(e, 'key', None) or getattr(e, 'entry_key', None) or ''
            etype = getattr(e, 'entry_type', None) or getattr(e, 'type', None) or 'misc'
            if not cite_key:
                continue
            fields: dict[str, str] = {}
            for fld in getattr(e, 'fields', []):
                k = getattr(fld, 'key', None)
                v = getattr(fld, 'value', None)
                if k is not None and v is not None:
                    fields[str(k).lower()] = str(v)
            _add_entry(str(cite_key), str(etype), fields)
        return entries

    raise RuntimeError("Unsupported bibtexparser installation: no load()/parse_file() API found.")


def _line_section_for(sections, line_idx: int) -> str:
    """0-based line index -> section label."""
    for sec in sections:
        if sec['start_line'] <= line_idx < sec['end_line']:
            return get_section_label(sec)
    return '(before first heading / no section)'


def _prepare_line_for_bracket_scan(line: str) -> str:
    """Unescape Markdown \\[ \\] and remove [text](url) spans so [ ... ] parsing is stable."""
    s = line.replace('\\[', '[').replace('\\]', ']')
    s = MARKDOWN_LINK.sub('', s)
    return s


def _strip_citation_author_prefix(author_part: str) -> str:
    """Normalize author part before comma-year (drop et al.)."""
    a = author_part.strip()
    a = re.sub(r'\bet\s+al\.?\s*$', '', a, flags=re.IGNORECASE).strip()
    return a


def _citation_author_tokens(author_part: str) -> list[str]:
    """Surnames to try from an in-text author fragment (first segment before year)."""
    a = _strip_citation_author_prefix(author_part)
    if not a:
        return []
    # Split on ';' already done upstream. Handle "A & B" / "A and B"
    primary = re.split(r'\s+;\s*', a)[0]
    if ' & ' in primary or ' and ' in primary.lower():
        # Prefer first author before & or 'and'
        if ' & ' in primary:
            first = primary.split('&')[0].strip()
        else:
            first = re.split(r'\s+and\s+', primary, maxsplit=1, flags=re.IGNORECASE)[0].strip()
    else:
        first = primary
    # "Smith et al." already stripped
    tokens = []
    for tok in re.split(r'[\s,]+', first):
        t = tok.strip()
        if t and t.lower() not in ('et', 'al'):
            tokens.append(t)
    if not tokens:
        return []
    # Last token is often surname for "First Last" or single word for "Smith"
    if len(tokens) == 1:
        return [_normalize_token(tokens[0])]
    # "Last, First" already handled by splitting first segment
    return [_normalize_token(tokens[-1]), _normalize_token(tokens[0])]


def _parse_year_token(y: str) -> tuple[int | None, str]:
    """Return (numeric year, suffix letter) from '2025' or '2018a'."""
    m = re.match(r'^((?:19|20)\d{2})([a-z]?)$', y, re.IGNORECASE)
    if not m:
        return None, ''
    return int(m.group(1)), (m.group(2) or '').lower()


def should_emit_citation_row(citation_text: str) -> bool:
    """True for [Author, Year] / year-only [2000] rows; false for CI ranges, NCT IDs, bare TODO."""
    raw = citation_text.strip()
    if re.match(r'^TODO\s*:', raw, re.IGNORECASE):
        return False
    if re.match(r'^TODO\s*$', raw, re.IGNORECASE):
        return False
    if YEAR_IN_CITATION.search(raw):
        return True
    if re.match(r'^\s*\d{4}[a-z]?\s*$', raw):
        return True
    return False


def match_citation_to_bib(citation_text: str, bib_entries: list[dict]) -> tuple[list[dict], str, str]:
    """
    Return (matching entries, status, notes).
    status: matched | ambiguous | no_match | year_only | no_year
    """
    raw = citation_text.strip()
    years = YEAR_IN_CITATION.findall(raw)
    if not years:
        return [], 'no_year', 'no (19|20)xx year in bracket; skipped or non-citation'

    # Use last year token in segment (author-year convention)
    ytok = years[-1]
    num_year, suffix = _parse_year_token(ytok)
    if num_year is None:
        return [], 'no_year', 'could not parse year'

    author_part = raw
    lm = None
    for m in YEAR_IN_CITATION.finditer(author_part):
        lm = m
    if lm:
        author_part = author_part[: lm.start()].rstrip(' ,;:')
    author_part = author_part.strip()

    if not author_part or re.match(r'^[\s\d\W]+$', author_part):
        # Year-only [2000]
        cand = [e for e in bib_entries if e['year'] == num_year]
        if len(cand) == 1:
            return cand, 'year_only', 'year-only citation; unique bib match for that year'
        if len(cand) == 0:
            return [], 'no_match', 'year-only; no bib entry for that year'
        return cand, 'ambiguous', 'year-only; multiple bib entries for that year'

    tokens = _citation_author_tokens(author_part)
    if not tokens:
        return [], 'no_match', 'could not parse author tokens'

    year_cand = [e for e in bib_entries if e['year'] == num_year]
    if not year_cand:
        return [], 'no_match', f'no bib entry with year={num_year}'

    # Institutional "FDA, 2018" / "FDA, 2018a" — match BibTeX keys containing "fda"
    if _normalize_token(author_part) == 'fda' or 'fda' in _normalize_token(author_part):
        fda_cands = [e for e in year_cand if 'fda' in e['cite_key'].lower()]
        if len(fda_cands) == 1:
            return fda_cands, 'matched', ''
        if len(fda_cands) > 1 and suffix:
            suff = [e for e in fda_cands if e['cite_key'].lower().endswith(suffix)]
            if len(suff) == 1:
                return suff, 'matched', 'disambiguated FDA guidance by letter suffix vs cite key'
        if len(fda_cands) > 1:
            return fda_cands[:5], 'ambiguous', 'multiple FDA-related bib entries for this year'

    # Match by first-author surname (FDA -> try 'fda' or 'food')
    scored: list[tuple[int, dict]] = []
    for e in year_cand:
        bl = e['first_author_norm']
        if not bl:
            continue
        best = 0
        for t in tokens:
            if t == bl:
                best = 3
                break
            if t and (t in bl or bl in t):
                best = max(best, 2)
            elif t and bl.startswith(t[:4]) and len(t) >= 4:
                best = max(best, 1)
        if best > 0:
            scored.append((best, e))

    if not scored:
        # Institutional / special: try loose substring on key
        lowered = _normalize_token(raw[:80])
        for e in year_cand:
            k = _normalize_token(e['cite_key'])
            if len(k) > 4 and (k in lowered or lowered in k):
                scored.append((1, e))

    if not scored:
        return [], 'no_match', 'no author/year alignment with bib'

    scored.sort(key=lambda x: -x[0])
    top_score = scored[0][0]
    top = [e for s, e in scored if s == top_score]

    if len(top) == 1:
        return top, 'matched', ''
    # Same publication duplicated under two cite keys in references.bib
    if len(top) == 2:
        ks = {top[0]['cite_key'], top[1]['cite_key']}
        if ks == {'Hudgens2021MCT', 'Hudgens2021'}:
            pref = next(t for t in top if t['cite_key'] == 'Hudgens2021MCT')
            return [pref], 'matched', 'duplicate Hudgens 2021 entries; prefer Hudgens2021MCT'

    # Multiple same score — try suffix letter in cite_key (e.g. ...2018a)
    if suffix:
        suff = [e for e in top if e['cite_key'].lower().endswith(suffix)]
        if len(suff) == 1:
            return suff, 'matched', 'disambiguated by letter suffix vs cite key'

    return top[:5], 'ambiguous', f'{len(top)} bib entries tie on author/year heuristics'


_ACUTE_LOWER = dict(
    zip(
        'aeiou',
        'áéíóú',
    )
)
_ACUTE_UPPER = dict(
    zip(
        'AEIOU',
        'ÁÉÍÓÚ',
    )
)


def _clean_bibtex_display(s: str) -> str:
    """Strip BibTeX brace protection and common TeX escapes for human-readable references."""
    if not s:
        return ''
    t = s.replace('\n', ' ')
    t = re.sub(r'\s+', ' ', t).strip()

    # Common TeX / LaTeX escapes (before brace removal)
    t = t.replace(r'\&', '&')
    t = t.replace(r'\%', '%')
    t = t.replace(r'\$', '$')
    t = t.replace(r'\#', '#')
    t = t.replace('---', '—')
    t = t.replace('--', '–')

    # Acute accent: \' {a} or \'a
    def _acute_repl(m: re.Match) -> str:
        c = m.group(1)
        if c.islower():
            return _ACUTE_LOWER.get(c, c)
        return _ACUTE_UPPER.get(c, c)

    t = re.sub(r"\\'\{([a-zA-Z])\}", _acute_repl, t)
    t = re.sub(r"\\'([a-zA-Z])\b", _acute_repl, t)

    # Umlaut via \"{o}
    _UML = {
        'a': 'ä',
        'e': 'ë',
        'i': 'ï',
        'o': 'ö',
        'u': 'ü',
        'A': 'Ä',
        'E': 'Ë',
        'I': 'Ï',
        'O': 'Ö',
        'U': 'Ü',
    }

    def _uml_repl(m: re.Match) -> str:
        c = m.group(1)
        return _UML.get(c, c)

    t = re.sub(r'\\"\{([a-zA-Z])\}', _uml_repl, t)

    # Circumflex \^{o}
    _CIRC = {'a': 'â', 'e': 'ê', 'i': 'î', 'o': 'ô', 'u': 'û', 'A': 'Â', 'E': 'Ê', 'I': 'Î', 'O': 'Ô', 'U': 'Û'}

    def _circ_repl(m: re.Match) -> str:
        c = m.group(1)
        return _CIRC.get(c, c)

    t = re.sub(r'\\\^\{([a-zA-Z])\}', _circ_repl, t)

    # Tilde \~{n}
    _TILDE = {'a': 'ã', 'n': 'ñ', 'o': 'õ', 'A': 'Ã', 'N': 'Ñ', 'O': 'Õ'}

    def _tilde_repl(m: re.Match) -> str:
        c = m.group(1)
        return _TILDE.get(c, c)

    t = re.sub(r'\\~\{([a-zA-Z])\}', _tilde_repl, t)

    # Ring / Angstrom
    t = t.replace(r'\AA', 'Å')
    t = t.replace(r'\aa', 'å')
    t = t.replace(r'\O', 'Ø')
    t = t.replace(r'\o', 'ø')
    t = t.replace(r'\ae', 'æ')
    t = t.replace(r'\AE', 'Æ')
    t = t.replace(r'\ss', 'ß')

    # Handle {\"a}, {\'e}, {\~n}, {\^o} patterns (braced accent groups)
    t = re.sub(r'\{\\"\s*([a-zA-Z])\}', _uml_repl, t)
    t = re.sub(r"\{\\'\\?\s*([a-zA-Z])\}", _acute_repl, t)
    t = re.sub(r'\{\\~\s*([a-zA-Z])\}', _tilde_repl, t)
    t = re.sub(r'\{\\\^\s*([a-zA-Z])\}', _circ_repl, t)

    # Unwrap BibTeX {...} groups innermost-first; treat {\AA} as Å when still braced
    def _one_brace_repl(m: re.Match) -> str:
        inner = m.group(1)
        if inner == '\\AA':
            return 'Å'
        if inner == '\\aa':
            return 'å'
        return inner

    prev = None
    while prev != t:
        prev = t
        t = re.sub(r'\{([^{}]*)\}', _one_brace_repl, t)

    # Stray backslash commands after unwrapping
    t = t.replace(r'\AA', 'Å').replace(r'\aa', 'å')

    # TeX-style doubled quotes (opening `` closing '')
    t = t.replace("``", '"').replace("''", '"')

    return t.strip()


def _format_bib_markdown(entry: dict) -> str:
    """Single reference formatted in APA 7th edition style for Markdown output.

    Format: Author, I. I., & Author, I. I. (Year). Title. *Journal*, *vol*(issue), pages. https://doi.org/DOI
    """
    # --- Authors ---
    raw_authors = entry.get('author') or ''
    author_list = _split_bibtex_authors(raw_authors)
    apa_authors = [_author_to_apa(a) for a in author_list]
    author_str = _format_author_list_apa(apa_authors)
    if len(author_str) > 300:
        author_str = author_str[:300] + '…'

    # --- Year ---
    year = entry.get('year') or 'n.d.'

    # --- Title ---
    title = _clean_bibtex_display((entry.get('title') or '').replace('\n', ' '))

    # --- Journal / source ---
    journal = _clean_bibtex_display((entry.get('journal') or '').replace('\n', ' '))

    # --- Volume, issue, pages ---
    volume = entry.get('volume') or ''
    number = entry.get('number') or ''
    pages = entry.get('pages') or ''

    # --- DOI ---
    doi = entry.get('doi') or ''

    # Normalize BibTeX page ranges: -- → –
    if pages:
        pages = pages.replace('--', '–')

    # --- Entry type (article vs techreport vs misc) ---
    entry_type = entry.get('ENTRYTYPE', 'article')

    # Build the citation
    parts: list[str] = []

    # Author (Year).
    if author_str:
        parts.append(f'{author_str} ({year}).')
    else:
        parts.append(f'({year}).')

    # Title — italicise for non-article types (books, reports, misc)
    if title:
        if entry_type in ('article',):
            parts.append(f'{title}.')
        else:
            parts.append(f'*{title}*.')

    # Journal, vol(issue), pages.
    if journal:
        source = f'*{journal}*'
        if volume:
            source += f', *{volume}*'
            if number:
                source += f'({number})'
        if pages:
            source += f', {pages}'
        source += '.'
        parts.append(source)
    elif volume or pages:
        # Non-journal with volume/pages (e.g., tech reports)
        vol_pages = []
        if volume:
            vol_pages.append(volume)
        if pages:
            vol_pages.append(pages)
        parts.append(', '.join(vol_pages) + '.')

    # DOI
    if doi:
        parts.append(f'https://doi.org/{doi}')

    return ' '.join(parts) if parts else entry['cite_key']


def collect_citation_events(
    filepath: str,
    sections,
) -> list[dict]:
    """
    Scan the full file for [ ... ] spans (excluding [TODO:...]), split compounds,
    and return ordered events with line numbers (1-based) and section labels.
    """
    lines = Path(filepath).read_text(encoding='utf-8').splitlines()
    events: list[dict] = []
    bracket_pat = re.compile(r'\[([^\]]+)\]')

    for line_idx, line in enumerate(lines):
        prepared = _prepare_line_for_bracket_scan(line)
        for m in bracket_pat.finditer(prepared):
            inner = m.group(1).strip()
            if not inner:
                continue
            if re.match(r'^TODO\s*:', inner, re.IGNORECASE):
                continue
            # Split compound citations (semicolon-separated)
            parts = [p.strip() for p in inner.split(';')]
            for part in parts:
                if not part:
                    continue
                if re.match(r'^TODO\s*:', part, re.IGNORECASE):
                    continue
                events.append(
                    {
                        'citation_raw': part,
                        'line': line_idx + 1,
                        'section': _line_section_for(sections, line_idx),
                    }
                )
    return events


def write_citation_report(
    filepath: str,
    sections,
    bib_path: str,
    csv_out: str | None,
    md_out: str | None,
) -> tuple[Path, Path, int]:
    """Write citations CSV + markdown bibliography; return paths and row count."""
    bib_entries = parse_references_bib(bib_path)
    events = collect_citation_events(filepath, sections)
    events = [e for e in events if should_emit_citation_row(e['citation_raw'])]

    rows: list[list[str]] = []
    header = [
        'seq',
        'citation_text',
        'line_approx',
        'section',
        'bib_key',
        'bib_title_short',
        'match_status',
        'uncertainty_flag',
        'notes',
    ]

    # Order-preserving unique for markdown bibliography
    seen_order: list[str] = []
    seen_set: set[str] = set()
    bib_by_key: dict[str, dict] = {e['cite_key']: e for e in bib_entries}

    for i, ev in enumerate(events, 1):
        cite = ev['citation_raw']
        matches, status, notes = match_citation_to_bib(cite, bib_entries)
        bib_key = ''
        title_short = ''
        uncertainty = ''

        if status == 'matched' or status == 'year_only':
            m = matches[0]
            bib_key = m['cite_key']
            t_clean = _clean_bibtex_display((m.get('title') or '').replace('\n', ' '))
            title_short = t_clean[:120]
            if len(t_clean) > 120:
                title_short += '…'
            uncertainty = ''
        elif status == 'ambiguous':
            bib_key = '|'.join(x['cite_key'] for x in matches[:5])
            title_short = 'see notes'
            uncertainty = 'ambiguous_match'
        elif status == 'no_match':
            uncertainty = 'no_bib_match'
        elif status == 'no_year':
            uncertainty = 'no_year_in_bracket'

        if status in ('ambiguous', 'no_match', 'no_year') or (status == 'year_only' and 'multiple' in notes):
            if not uncertainty:
                uncertainty = 'review'

        rows.append(
            [
                str(i),
                cite,
                str(ev['line']),
                ev['section'],
                bib_key,
                title_short.replace('\n', ' '),
                status,
                uncertainty,
                notes,
            ]
        )

        # Unique keys for bibliography (matched/ambiguous: skip unresolved)
        if status == 'matched' or status == 'year_only':
            k = matches[0]['cite_key']
            if k not in seen_set:
                seen_set.add(k)
                seen_order.append(k)

    base = Path(filepath)
    csv_path = Path(csv_out) if csv_out else base.with_suffix('.citations.csv')
    md_path = Path(md_out) if md_out else base.with_suffix('.citations.bibliography.md')

    with csv_path.open('w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)

    md_lines = [
        '# Bibliography (in order of first in-text citation)',
        '',
        f'Source document: `{base.name}`',
        f'BibTeX database: `{Path(bib_path).name}`',
        '',
        'Unresolved or ambiguous citations are listed only in the CSV with `match_status` / `uncertainty_flag`.',
        '',
    ]
    for n, key in enumerate(seen_order, 1):
        e = bib_by_key.get(key)
        if not e:
            continue
        md_lines.append(f'{n}. {_format_bib_markdown(e)}  ')
        md_lines.append('')

    md_path.write_text('\n'.join(md_lines), encoding='utf-8')

    return csv_path, md_path, len(rows)


def _slugify(text: str) -> str:
    """Convert text to a filename-safe slug: lowercase, non-alphanum -> hyphens."""
    slug = text.strip().lower()
    slug = re.sub(r'[^a-z0-9]+', '-', slug)
    slug = slug.strip('-')
    return slug or 'untitled'


def split_document(sections, output_dir: str):
    """Decompose parsed sections into per-section files in *output_dir*.

    Each section becomes a separate .md file named
    ``{index:03d}_{section_number}_{slugified_title}.md``.
    A ``_manifest.txt`` listing filenames in order is also written.
    """
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    filenames: list[str] = []
    for idx, sec in enumerate(sections, 1):
        num_part = sec['section_number'] if sec['section_number'] else 'unnumbered'
        title_slug = _slugify(sec['title']) if sec['title'] else 'untitled'
        fname = f"{idx:03d}_{num_part}_{title_slug}.md"
        filenames.append(fname)
        (out / fname).write_text(sec['content'], encoding='utf-8')

    (out / '_manifest.txt').write_text(
        '\n'.join(filenames) + '\n', encoding='utf-8'
    )


def assemble_document(input_dir: str, output_path: str):
    """Reassemble section files from *input_dir* into a single document.

    Reads ``_manifest.txt`` for ordering and concatenates section files.
    """
    inp = Path(input_dir)
    manifest = inp / '_manifest.txt'
    filenames = manifest.read_text(encoding='utf-8').strip().splitlines()

    parts: list[str] = []
    for fname in filenames:
        parts.append((inp / fname).read_text(encoding='utf-8'))

    Path(output_path).write_text(''.join(parts), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(
        description='Extract sections from a Markdown document by heading number.',
        epilog='Examples:\n'
               '  %(prog)s document.md              # Print full outline\n'
               '  %(prog)s document.md 3.4           # Extract section 3.4\n'
               '  %(prog)s document.md 2 3.4         # Extract sections 2 and 3.4\n'
               '  %(prog)s document.md --outline 3.4 # Outline + section 3.4\n'
               '  %(prog)s document.md --citations   # Citation CSV + bibliography .md\n',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('filepath', nargs='?', default=None,
                        help='Path to the Markdown document')
    parser.add_argument('--outline', action='store_true',
                        help=('Print the document outline (in addition to any extracted sections) '
                              'and write <document>-toc.md'))
    parser.add_argument('--no-headers', action='store_true',
                        help='Exclude heading lines from extracted section content')
    parser.add_argument(
        '--todos',
        nargs='?',
        const='',
        metavar='OUTPUT',
        help=('Scan for embedded TODOs in format "[TODO: ...]" and write a CSV report. '
              'Optionally provide OUTPUT path; default is <document>.todos.csv')
    )
    parser.add_argument(
        '--citations',
        nargs='?',
        const='',
        metavar='OUTPUT_CSV',
        help=('Find in-text citations in square brackets (excluding [TODO: ...]), match '
              'against a BibTeX file, and write <document>.citations.csv plus '
              '<document>.citations.bibliography.md. Optional path overrides the CSV path; '
              'the markdown path is the same base with .citations.bibliography.md')
    )
    parser.add_argument(
        '--bib',
        metavar='PATH',
        help='BibTeX database for --citations (default: references.bib next to the document, '
             'or ./references.bib)'
    )
    parser.add_argument(
        '--split',
        metavar='DIR',
        help='Split document into per-section files in DIR (writes _manifest.txt for ordering)'
    )
    parser.add_argument(
        '--assemble',
        nargs=2,
        metavar=('DIR', 'OUTPUT'),
        help='Reassemble section files from DIR into OUTPUT using _manifest.txt ordering'
    )

    args, remaining = parser.parse_known_args()
    args.sections = remaining

    # --assemble does not require parsing a source document
    if args.assemble:
        input_dir, output_path = args.assemble
        assemble_document(input_dir, output_path)
        print(f"Assembled document written to: {output_path}")
        return

    if not args.filepath:
        parser.error("filepath is required (unless using --assemble)")

    if not Path(args.filepath).exists():
        print(f"Error: File not found: {args.filepath}", file=sys.stderr)
        sys.exit(1)

    sections = parse_document(args.filepath)

    if not sections:
        print("No numbered headings found in the document.", file=sys.stderr)
        sys.exit(1)

    if args.split:
        split_document(sections, args.split)
        print(f"Split {len(sections)} section(s) into: {args.split}")
        return

    todo_output_path = None if args.todos is None else (args.todos or None)
    if args.todos is not None:
        out_path, todo_count = write_todo_report(args.filepath, sections, todo_output_path)
        print(f"Wrote TODO report with {todo_count} item(s) to: {out_path}")

    if args.citations is not None:
        doc_dir = Path(args.filepath).resolve().parent
        if args.bib:
            bib_path = Path(args.bib).expanduser()
        else:
            cand = doc_dir / 'references.bib'
            bib_path = cand if cand.is_file() else Path('references.bib')
        if not bib_path.is_file():
            print(f"Error: BibTeX file not found: {bib_path}", file=sys.stderr)
            sys.exit(1)
        csv_arg = args.citations or None
        csv_out = csv_arg
        md_out = None
        if csv_arg:
            p = Path(csv_arg)
            md_out = str(p.with_suffix('')) + '.citations.bibliography.md'
        csv_path, md_path, n = write_citation_report(
            args.filepath, sections, str(bib_path), csv_out, md_out
        )
        print(f"Wrote citation table ({n} row(s)) to: {csv_path}")
        print(f"Wrote ordered bibliography (markdown) to: {md_path}")

    # If no sections requested and no --outline flag, default to showing outline.
    # If --todos or --citations is supplied by itself, skip implicit outline output.
    show_outline = args.outline or (
        not args.sections and args.todos is None and args.citations is None
    )

    if show_outline:
        print("=== DOCUMENT OUTLINE ===\n")
        print(get_outline(sections))
        print()
        if args.outline:
            toc_path = write_toc_markdown(args.filepath, sections)
            print(f"Wrote markdown table of contents to: {toc_path}")
            print()

    if args.sections:
        for target in args.sections:
            if re.match(r'^\d', target):
                extracted = extract_section(sections, target)
                label = f"Section {target}"
            else:
                extracted = extract_section_by_title(sections, target)
                label = f"Section '{target}'"
            if not extracted:
                print(f"--- {label}: NOT FOUND ---\n", file=sys.stderr)
            else:
                print(f"=== {label.upper()} ===\n")
                print(format_sections(extracted, include_headers=not args.no_headers))
                print()


if __name__ == '__main__':
    main()
