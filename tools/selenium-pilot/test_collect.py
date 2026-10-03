import json
import io
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import collect

TITLE = "An empirical study of scientific collaboration"
DOI = "10.1234/example.1"
ABSTRACT = "We study scientific collaboration using a panel of researchers and their publications. Our results show how access to information affects research outcomes."


def page(extra="", doi=DOI):
    return f'''<html><head><meta name="citation_doi" content="{doi}">
      <meta name="citation_title" content="{TITLE}"></head><body>{extra}</body></html>'''


class ExtractionTest(unittest.TestCase):
    def test_doi_conflict_never_adopts_abstract(self):
        result = collect.extract_article(page(f'<section id="abstract">{ABSTRACT}</section>', "10.1234/wrong"),
                                         "https://example.org/doi/" + DOI, {"doi": DOI})
        self.assertEqual(result["status"], "identity_conflict")
        self.assertEqual(result["abstract"], "")

    def test_url_alone_is_not_article_identity(self):
        result = collect.extract_article('<h1>Please wait</h1>', "https://example.org/doi/" + DOI, {"doi": DOI})
        self.assertEqual(result["status"], "identity_unverified")

    def test_marketing_description_is_not_abstract(self):
        html = page(f'<meta name="description" content="{ABSTRACT}">')
        self.assertEqual(collect.extract_article(html, "https://example.org", {"doi": DOI})["status"], "metadata_only")

    def test_heading_does_not_capture_introduction(self):
        html = page(f'<h2>Abstract</h2><p>{ABSTRACT}</p><h2>Introduction</h2><p>Not the abstract</p>')
        self.assertEqual(collect.extract_article(html, "https://example.org", {"doi": DOI})["abstract"], ABSTRACT)

    def test_jsonld_related_article_not_adopted(self):
        node = {"@type": "ScholarlyArticle", "identifier": "10.1234/other", "abstract": ABSTRACT}
        html = page('<script type="application/ld+json">' + json.dumps(node) + '</script>')
        self.assertEqual(collect.extract_article(html, "https://example.org", {"doi": DOI})["abstract"], "")

    def test_related_dom_abstract_not_adopted(self):
        html = page(f'<aside class="related-articles"><div class="abstract">{ABSTRACT}</div></aside>')
        self.assertEqual(collect.extract_article(html, "https://example.org", {"doi": DOI})["abstract"], "")

    def test_dublin_core_authors_are_preserved(self):
        html = page('<meta name="dc.Creator" content="Mert Demirer"><meta name="dc.Creator" content="Ömer Karaduman">')
        self.assertEqual(collect.extract_article(html, "https://example.org", {"doi": DOI})["authors"],
                         ["Mert Demirer", "Ömer Karaduman"])

    def test_both_languages_challenge_detected(self):
        for text in ("正在进行安全验证", "Verify you are human"):
            self.assertEqual(collect.page_status("", text), "needs_verification")
        self.assertEqual(collect.challenge_provider("<script src='/cdn-cgi/challenge-platform/a'></script>",
                                                   "needs_verification"), "cloudflare")
        self.assertIsNone(collect.challenge_provider("Powered by Cloudflare", "loaded"))

    def test_catalog_dedup_and_offsite_exclusion(self):
        html = f'''<a href="/doi/{DOI}">{TITLE}</a><a href="/doi/abs/{DOI}">{TITLE}</a>
          <a href="https://other.example/doi/10.1234/other">Other journal article</a>
          <a href="/doi/pdf/{DOI}">Download full paper</a>'''
        rows = collect.extract_catalog(html, "https://example.org/toc/current")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["doi"], DOI)

    def test_less_than_three_seconds_rejected_before_browser(self):
        with patch("collect.create_driver") as create, patch("sys.stderr", new_callable=io.StringIO):
            with self.assertRaises(SystemExit) as caught:
                collect.main(["--interval", "1"])
            self.assertEqual(caught.exception.code, 2)
            create.assert_not_called()

    def test_checkpoint_preserves_failure_as_failure(self):
        args = SimpleNamespace(engine="selenium", browser="edge", headless=False,
                               interval=3, settle=5, manual_wait=0)
        records = [{"journal": "JPE", "requested_url": "https://example.org", "elapsed_seconds": 5,
                    "status": "needs_verification"}]
        with TemporaryDirectory() as tmp:
            collect.save_results(Path(tmp), records, args)
            stored = json.loads((Path(tmp) / "results.json").read_text(encoding="utf-8"))
            self.assertFalse(stored["production_imported"])
            self.assertEqual(stored["records"][0]["status"], "needs_verification")

    def test_cloudflare_helper_call_is_not_itself_success(self):
        args = SimpleNamespace(timeout=10, settle=0, manual_wait=0, headless=False, click_checkbox=True)
        snap = {"html": "<title>Cloudflare</title>", "body": "Verify you are human",
                "title": "Just a moment", "url": "https://example.org/", "gate": True}
        with TemporaryDirectory() as tmp, patch("collect.snapshot", return_value=snap), patch("collect.time.sleep"):
            from unittest.mock import MagicMock
            driver = MagicMock()
            driver.execute_script.return_value = "complete"
            result = collect.collect_one(driver, {"url": snap["url"]}, args, Path(tmp))
            driver.click_checkbox_once.assert_called_once()
            self.assertEqual(result["status"], "needs_verification")
            self.assertNotIn("abstract", result)


if __name__ == "__main__":
    unittest.main()
