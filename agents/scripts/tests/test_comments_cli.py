#!/usr/bin/env python3
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from comments_cli import (
    assign_section_guesses,
    filter_comments,
    group_comments_by_tag,
    load_comments,
)


class CommentsCliTests(unittest.TestCase):
    def test_load_comments_supports_ndjson_pages(self):
        first_page = {
            "comments": [
                {"author": {"displayName": "Alice"}, "content": "one", "resolved": False}
            ],
            "nextPageToken": "abc",
        }
        second_page = {
            "comments": [
                {"author": {"displayName": "Bob"}, "content": "two", "resolved": True}
            ]
        }
        payload = json.dumps(first_page) + "\n" + json.dumps(second_page)

        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "comments.json"
            path.write_text(payload, encoding="utf-8")
            comments = load_comments(path)

        self.assertEqual(len(comments), 2)
        self.assertEqual(comments[0]["author"]["displayName"], "Alice")
        self.assertEqual(comments[1]["author"]["displayName"], "Bob")

    def test_filter_comments_excludes_resolved_by_default(self):
        comments = [
            {"author": {"displayName": "Alice"}, "content": "open", "resolved": False},
            {"author": {"displayName": "Bob"}, "content": "done", "resolved": True},
        ]

        filtered = filter_comments(comments)
        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0]["author"]["displayName"], "Alice")

    def test_filter_comments_include_resolved_when_requested(self):
        comments = [
            {"author": {"displayName": "Alice"}, "content": "open", "resolved": False},
            {"author": {"displayName": "Bob"}, "content": "done", "resolved": True},
        ]

        filtered = filter_comments(comments, include_resolved=True)
        self.assertEqual(len(filtered), 2)

    def test_filter_comments_author_and_content_keywords_case_insensitive(self):
        comments = [
            {
                "author": {"displayName": "Alice Smith"},
                "content": "Please revise endpoint wording",
                "resolved": False,
            },
            {
                "author": {"displayName": "Bob Jones"},
                "content": "Looks good",
                "resolved": False,
            },
        ]

        author_match = filter_comments(comments, author_keyword="alice")
        self.assertEqual(len(author_match), 1)
        self.assertEqual(author_match[0]["author"]["displayName"], "Alice Smith")

        content_match = filter_comments(comments, content_keyword="ENDPOINT")
        self.assertEqual(len(content_match), 1)
        self.assertIn("endpoint", content_match[0]["content"].lower())

        both_match = filter_comments(
            comments, author_keyword="alice", content_keyword="endpoint"
        )
        self.assertEqual(len(both_match), 1)

    def test_assign_section_guesses_prefers_unique_snippet_matches(self):
        doc_text = """# 1 Intro
General setup text.

## 1.1 Eligibility
Include adults with treatment-resistant depression and documented baseline score.

## 1.2 Outcomes
Primary endpoint is remission at day 42.
"""
        comments = [
            {
                "quotedFileContent": {
                    "value": "Include adults with treatment-resistant depression"
                }
            },
            {"quotedFileContent": {"value": "Primary endpoint is remission at day 42"}},
        ]

        guessed = assign_section_guesses(comments, doc_text)
        self.assertEqual(guessed[0]["guessed_section"], "1.1 Eligibility")
        self.assertEqual(guessed[1]["guessed_section"], "1.2 Outcomes")

    def test_assign_section_guesses_uses_order_for_ambiguous_snippet(self):
        doc_text = """# 1 Intro
Context.

## 1.1 Data Source
The selected dataset was chosen for coverage.
Data quality checks are required.
Eligibility checks are required.

## 1.2 Analysis
Model assumptions are documented.
Sensitivity checks are required.
"""
        comments = [
            {"quotedFileContent": {"value": "selected dataset was chosen"}},
            {"quotedFileContent": {"value": "checks are required"}},
        ]

        guessed = assign_section_guesses(comments, doc_text)
        self.assertEqual(guessed[0]["guessed_section"], "1.1 Data Source")
        self.assertEqual(guessed[1]["guessed_section"], "1.1 Data Source")

    def test_group_comments_by_tag_includes_multi_tag_comments(self):
        comments = [
            {"content": "@alice please check with @bob@example.com"},
            {"content": "no tags here"},
            {"content": "@alice follow-up"},
        ]

        grouped = group_comments_by_tag(comments)
        self.assertIn("alice", grouped)
        self.assertIn("bob@example.com", grouped)
        self.assertIn("none", grouped)
        self.assertEqual(len(grouped["alice"]), 2)
        self.assertEqual(len(grouped["bob@example.com"]), 1)
        self.assertEqual(len(grouped["none"]), 1)

    def test_group_comments_by_tag_is_case_insensitive_and_deduplicated(self):
        comments = [
            {"content": "@Alice ping @alice about this"},
        ]

        grouped = group_comments_by_tag(comments)
        self.assertIn("alice", grouped)
        self.assertIn("none", grouped)
        self.assertEqual(len(grouped["alice"]), 1)
        self.assertEqual(len(grouped["none"]), 0)


if __name__ == "__main__":
    unittest.main()
