#!/usr/bin/env python3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from read_sections import (
    parse_document,
    collect_todos,
    write_todo_report,
    write_toc_markdown,
    should_emit_citation_row,
    collect_citation_events,
    _clean_bibtex_display,
    _split_bibtex_authors,
    _format_author_list,
)


class ReadSectionsTodosTests(unittest.TestCase):
    def test_write_toc_markdown_includes_front_matter_and_numbered_sections(self):
        content = """# Abbreviations
Some terms.

# Synopsis
High-level summary.

## 1. Introduction
Intro text.

### 1.1 Primary Objective
Objective details.
"""
        with tempfile.TemporaryDirectory() as tmpdir:
            doc = Path(tmpdir) / "draft.md"
            doc.write_text(content, encoding="utf-8")
            sections = parse_document(str(doc))

            toc_path = write_toc_markdown(str(doc), sections)
            self.assertEqual(toc_path, doc.with_name("draft-toc.md"))

            toc_text = toc_path.read_text(encoding="utf-8")
            self.assertIn("# Table of Contents", toc_text)
            self.assertNotIn("Source document:", toc_text)
            self.assertIn("[Abbreviations](#abbreviations)", toc_text)
            self.assertIn("[Synopsis](#synopsis)", toc_text)
            self.assertIn("[1 Introduction](#1-introduction)", toc_text)
            self.assertIn("  [1.1 Primary Objective](#11-primary-objective)", toc_text)
            self.assertNotIn("- [Abbreviations]", toc_text)
            toc_lines = [line for line in toc_text.splitlines() if line.strip().startswith("[")]
            self.assertTrue(all(line.endswith("  ") for line in toc_lines))

    def test_collect_todos_uses_number_or_title_labels(self):
        content = """# Executive Summary
Some setup. [TODO: tighten summary framing.]

## 1. Introduction
Study rationale text. [TODO: add citation.]

### 1.1 Design
Methods details. [TODO: clarify endpoint window.]
"""
        with tempfile.TemporaryDirectory() as tmpdir:
            doc = Path(tmpdir) / "protocol.md"
            doc.write_text(content, encoding="utf-8")
            sections = parse_document(str(doc))
            todos = collect_todos(sections)

            self.assertEqual(len(todos), 3)
            self.assertEqual(todos[0]["section_label"], "Executive Summary")
            self.assertEqual(todos[1]["section_label"], "1 Introduction")
            self.assertEqual(todos[2]["section_label"], "1.1 Design")

    def test_write_todo_report_default_file_and_contents(self):
        content = """# 2. Analysis
Main text.
[TODO: define estimand explicitly.]
[TODO: justify NI margin source.]
"""
        with tempfile.TemporaryDirectory() as tmpdir:
            doc = Path(tmpdir) / "sap.md"
            doc.write_text(content, encoding="utf-8")
            sections = parse_document(str(doc))
            output_path, count = write_todo_report(str(doc), sections)

            self.assertEqual(output_path, doc.with_suffix(".todos.csv"))
            self.assertEqual(count, 2)

            report = output_path.read_text(encoding="utf-8")
            lines = report.splitlines()
            self.assertEqual(
                lines[0],
                "todo #,TODO,section,user directive",
            )
            self.assertEqual(
                lines[1],
                "1,define estimand explicitly.,2 Analysis,",
            )
            self.assertEqual(
                lines[2],
                "2,justify NI margin source.,2 Analysis,",
            )

    def test_clean_bibtex_display_strips_braces_and_tex(self):
        self.assertEqual(
            _clean_bibtex_display(r"Foo ({BAR}) and {\AA}xyz"),
            "Foo (BAR) and Åxyz",
        )
        self.assertEqual(
            _clean_bibtex_display(r"Hern\'{a}n, M"),
            "Hernán, M",
        )

    def test_author_split_and_join_uses_commas_and_single_and(self):
        authors = _split_bibtex_authors(
            r"Hern\'{a}n, Miguel A and Robins, James M and {GBD 2021 Suicide Collaborators}"
        )
        self.assertEqual(
            authors,
            ["Hernán, Miguel A", "Robins, James M", "GBD 2021 Suicide Collaborators"],
        )
        self.assertEqual(
            _format_author_list(authors),
            "Hernán, Miguel A, Robins, James M, and GBD 2021 Suicide Collaborators",
        )

    def test_author_split_preserves_and_inside_braced_group(self):
        authors = _split_bibtex_authors(
            r"{U.S. Food and Drug Administration, Center for Drug Evaluation and Research}"
        )
        self.assertEqual(
            authors,
            ["U.S. Food and Drug Administration, Center for Drug Evaluation and Research"],
        )

    def test_should_emit_citation_row_filters_ci_ranges_and_keeps_author_year(self):
        self.assertTrue(should_emit_citation_row("Smith et al., 2020"))
        self.assertTrue(should_emit_citation_row("2000"))
        self.assertFalse(should_emit_citation_row("−7.31, −0.64"))
        self.assertFalse(should_emit_citation_row("TODO"))

    def test_collect_citation_events_skips_todo_bracket_and_splits_semicolon(self):
        content = r"""## 1. Methods
Alpha \[Jones et al., 1999; Smith, 2000\].
Beta [TODO: fix this].
"""
        with tempfile.TemporaryDirectory() as tmpdir:
            doc = Path(tmpdir) / "p.md"
            doc.write_text(content, encoding="utf-8")
            sections = parse_document(str(doc))
            ev = collect_citation_events(str(doc), sections)
            texts = [e["citation_raw"] for e in ev]
            self.assertEqual(
                texts,
                ["Jones et al., 1999", "Smith, 2000"],
            )


if __name__ == "__main__":
    unittest.main()
