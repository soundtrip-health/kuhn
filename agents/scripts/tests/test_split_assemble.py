#!/usr/bin/env python3
"""Tests for split_document and assemble_document in read_sections.py."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from read_sections import parse_document, split_document, assemble_document

SAMPLE_DOC = """\
# 1 Introduction

Intro text.

## 1.1 Background

Background.

# 2 Methods

Methods.
"""


class TestSplitDocument(unittest.TestCase):
    """Tests for split_document."""

    def setUp(self):
        self.tmpdir_obj = tempfile.TemporaryDirectory()
        self.tmpdir = self.tmpdir_obj.name
        self.doc_path = Path(self.tmpdir) / "doc.md"
        self.doc_path.write_text(SAMPLE_DOC, encoding="utf-8")
        self.sections = parse_document(str(self.doc_path))
        self.split_dir = Path(self.tmpdir) / "sections"

    def tearDown(self):
        self.tmpdir_obj.cleanup()

    def test_creates_one_file_per_section(self):
        split_document(self.sections, str(self.split_dir))
        md_files = sorted(self.split_dir.glob("*.md"))
        self.assertEqual(len(md_files), 3)

    def test_correct_naming(self):
        split_document(self.sections, str(self.split_dir))
        md_files = sorted(f.name for f in self.split_dir.glob("*.md"))
        self.assertEqual(md_files, [
            "001_1_introduction.md",
            "002_1.1_background.md",
            "003_2_methods.md",
        ])

    def test_preserves_section_content(self):
        split_document(self.sections, str(self.split_dir))
        intro = (self.split_dir / "001_1_introduction.md").read_text(encoding="utf-8")
        # Should contain the heading and body but NOT content from other sections
        self.assertIn("# 1 Introduction", intro)
        self.assertIn("Intro text.", intro)
        self.assertNotIn("Background.", intro)
        self.assertNotIn("Methods.", intro)

    def test_writes_manifest(self):
        split_document(self.sections, str(self.split_dir))
        manifest = self.split_dir / "_manifest.txt"
        self.assertTrue(manifest.exists())
        lines = manifest.read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(lines, [
            "001_1_introduction.md",
            "002_1.1_background.md",
            "003_2_methods.md",
        ])


class TestAssembleDocument(unittest.TestCase):
    """Tests for assemble_document."""

    def setUp(self):
        self.tmpdir_obj = tempfile.TemporaryDirectory()
        self.tmpdir = self.tmpdir_obj.name
        self.doc_path = Path(self.tmpdir) / "doc.md"
        self.doc_path.write_text(SAMPLE_DOC, encoding="utf-8")
        self.sections = parse_document(str(self.doc_path))
        self.split_dir = Path(self.tmpdir) / "sections"
        self.output_path = Path(self.tmpdir) / "assembled.md"

    def tearDown(self):
        self.tmpdir_obj.cleanup()

    def test_roundtrip(self):
        """Split then assemble produces the original document byte-for-byte."""
        split_document(self.sections, str(self.split_dir))
        assemble_document(str(self.split_dir), str(self.output_path))
        original = self.doc_path.read_text(encoding="utf-8")
        assembled = self.output_path.read_text(encoding="utf-8")
        self.assertEqual(original, assembled)

    def test_respects_manifest_order(self):
        """Assemble uses _manifest.txt ordering, not filesystem sort."""
        split_document(self.sections, str(self.split_dir))
        # Reverse the manifest
        manifest = self.split_dir / "_manifest.txt"
        lines = manifest.read_text(encoding="utf-8").strip().splitlines()
        manifest.write_text("\n".join(reversed(lines)) + "\n", encoding="utf-8")
        assemble_document(str(self.split_dir), str(self.output_path))
        assembled = self.output_path.read_text(encoding="utf-8")
        # The assembled doc should start with Methods (last section now first)
        self.assertTrue(assembled.startswith("# 2 Methods"))

    def test_editing_a_section_then_assembling(self):
        """Editing a section file then assembling incorporates the edit."""
        split_document(self.sections, str(self.split_dir))
        # Edit the intro section
        intro_file = self.split_dir / "001_1_introduction.md"
        intro_text = intro_file.read_text(encoding="utf-8")
        intro_file.write_text(
            intro_text.replace("Intro text.", "Updated intro text."),
            encoding="utf-8",
        )
        assemble_document(str(self.split_dir), str(self.output_path))
        assembled = self.output_path.read_text(encoding="utf-8")
        self.assertIn("Updated intro text.", assembled)
        self.assertNotIn("Intro text.", assembled)


class TestSplitUnnumberedSections(unittest.TestCase):
    """Edge case: unnumbered sections get a slug from their title."""

    def setUp(self):
        self.tmpdir_obj = tempfile.TemporaryDirectory()
        self.tmpdir = self.tmpdir_obj.name
        doc_text = "# Synopsis\n\nSynopsis text.\n\n# 1 Introduction\n\nIntro.\n"
        self.doc_path = Path(self.tmpdir) / "doc.md"
        self.doc_path.write_text(doc_text, encoding="utf-8")
        self.sections = parse_document(str(self.doc_path))
        self.split_dir = Path(self.tmpdir) / "sections"

    def tearDown(self):
        self.tmpdir_obj.cleanup()

    def test_unnumbered_section_naming(self):
        split_document(self.sections, str(self.split_dir))
        md_files = sorted(f.name for f in self.split_dir.glob("*.md"))
        # Unnumbered section uses title as slug; section_number is None -> "unnumbered"
        self.assertEqual(md_files[0], "001_unnumbered_synopsis.md")
        self.assertEqual(md_files[1], "002_1_introduction.md")

    def test_unnumbered_roundtrip(self):
        split_document(self.sections, str(self.split_dir))
        output = Path(self.tmpdir) / "assembled.md"
        assemble_document(str(self.split_dir), str(output))
        original = self.doc_path.read_text(encoding="utf-8")
        assembled = output.read_text(encoding="utf-8")
        self.assertEqual(original, assembled)


if __name__ == "__main__":
    unittest.main()
