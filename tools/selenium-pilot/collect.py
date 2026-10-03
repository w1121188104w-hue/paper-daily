"""Small, isolated Selenium collection experiment; never writes the paper library."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from datetime import datetime, timezone
from urllib.parse import parse_qs, unquote, urljoin, urlsplit

from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

HERE = Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "selenium-pilot"
CHALLENGE = re.compile(
    r"verify (?:that )?you are (?:a )?human|verify you are|checking your browser|"
    r"just a moment|security verification|robot check|are you a robot|"
    r"人机验证|验证您是否|安全验证", re.I)
DENIED = re.compile(r"access denied|request (?:was )?blocked|403 forbidden|"
                    r"unusual traffic|too many requests|rate limit exceeded", re.I)
ABSTRACT_SELECTORS = [
    "#abstract", "#Abs1", "#enc-abstract", ".article-abstract", ".abstractInFull",
    ".abstractSection", "[role='doc-abstract']", "section.abstract", "div.abstract",
    ".article__abstract", ".article-information .abstract",
]


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def title_key(value):
    return re.sub(r"[^\w]", "", clean(value).casefold())


def normalize_doi(value):
    value = unquote(clean(value))
    value = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", value, flags=re.I)
    return value.lower() if re.fullmatch(r"10\.\d{4,9}/[^\s?#]+", value, re.I) else ""


def doi_from_url(url):
    parts = urlsplit(url)
    if parts.hostname in {"doi.org", "dx.doi.org"}:
        return normalize_doi(parts.path[1:])
    query = parse_qs(parts.query)
    for key in ("id", "doi"):
        if normalize_doi(query.get(key, [""])[0]):
            return normalize_doi(query[key][0])
    found = re.search(r"/(?:doi/(?:abs/|full/|epdf/|pdf/)?|article/)(10\..+)", parts.path)
    return normalize_doi(found.group(1)) if found else ""


def valid_url(url):
    parts = urlsplit(url)
    return (parts.scheme == "https" and bool(parts.hostname) and not parts.username
            and not parts.password and not parts.port)


def page_status(title, body, visible_gate=False):
    top = clean(title) + " " + clean(body)[:1800]
    if visible_gate or CHALLENGE.search(top):
        return "needs_verification"
    if DENIED.search(top):
        return "access_restricted"
    if re.search(r"this site can.t be reached|ERR_(?:CONNECTION|NAME|TIMED)|无法访问此页面", top, re.I):
        return "network_error"
    return "loaded"


def challenge_provider(html, status):
    if status != "needs_verification":
        return None
    if re.search(r"cloudflare|turnstile|_cf_chl|challenge-platform", html, re.I):
        return "cloudflare"
    if re.search(r"hcaptcha\.com|h-captcha", html, re.I):
        return "hcaptcha"
    if re.search(r"recaptcha", html, re.I):
        return "recaptcha"
    return "unknown"


def abstract_text(value):
    text = clean(BeautifulSoup(str(value or ""), "html.parser").get_text(" "))
    text = re.sub(r"^abstract\s*[:：]?\s*", "", text, flags=re.I)
    if len(text) < 60 or CHALLENGE.search(text) or DENIED.search(text):
        return ""
    if re.search(r"^(?:no abstract|abstract (?:is )?(?:not available|unavailable))", text, re.I):
        return ""
    return text


def extract_article(html, url, task):
    soup = BeautifulSoup(html, "html.parser")
    meta = {}
    for item in soup.select("meta[content]"):
        key = str(item.get("name") or item.get("property") or "").lower()
        meta.setdefault(key, []).append(clean(item["content"]))
    first = lambda *keys: next((v for k in keys for v in meta.get(k, []) if v), "")
    expected = normalize_doi(task.get("doi"))
    dois = {normalize_doi(v) for k in ("citation_doi", "dc.identifier", "prism.doi")
            for v in meta.get(k, []) if normalize_doi(v)}
    # Only Article entities; never borrow a related item's abstract.
    entities = []
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            raw = json.loads(script.string or script.get_text())
            pending = raw if isinstance(raw, list) else [raw]
            while pending:
                node = pending.pop(0)
                if not isinstance(node, dict):
                    continue
                pending.extend(node.get("@graph", []) if isinstance(node.get("@graph"), list) else [])
                types = node.get("@type", [])
                types = [types] if isinstance(types, str) else types
                if set(types) & {"ScholarlyArticle", "Article", "MedicalScholarlyArticle"}:
                    entities.append(node)
        except (ValueError, TypeError):
            continue
    entity = {}
    for node in entities:
        ident = node.get("identifier", "")
        if isinstance(ident, dict):
            ident = ident.get("value", "")
        node_doi = normalize_doi(ident) or doi_from_url(str(node.get("url", "")))
        if node_doi and (node_doi == expected or (not expected and len(entities) == 1)):
            entity = node
            dois.add(node_doi)
            break
    actual = next(iter(dois)) if len(dois) == 1 else ""
    title = first("citation_title", "dc.title") or clean(entity.get("headline") or entity.get("name"))
    if not title and soup.h1:
        title = clean(soup.h1.get_text(" "))
    record = {
        "title": title, "doi": actual, "expected_doi": expected,
        "authors": meta.get("citation_author") or meta.get("dc.creator", []),
        "journal_name": first("citation_journal_title", "prism.publicationname"),
        "publication_date_raw": first("citation_online_date", "citation_publication_date", "dc.date"),
        "abstract": "", "abstract_source": "", "url": url,
    }
    if len(dois) > 1 or (expected and actual and actual != expected):
        return {**record, "status": "identity_conflict"}
    if task.get("title") and title and title_key(task["title"]) != title_key(title):
        return {**record, "status": "identity_conflict"}
    # URL DOI alone is not proof: a verification or error page can retain that URL.
    if not actual or not title:
        return {**record, "status": "identity_unverified"}
    abstract = abstract_text(first("citation_abstract") or entity.get("abstract"))
    source = "article_metadata" if abstract else ""
    for selector in ABSTRACT_SELECTORS:
        if abstract:
            break
        for candidate in soup.select(selector):
            if any(re.search(r"related|recommend|references", " ".join(
                    [str(parent.get("id", "")), " ".join(parent.get("class", []))]), re.I)
                   for parent in [candidate, *candidate.parents] if getattr(parent, "attrs", None)):
                continue
            copy = BeautifulSoup(str(candidate), "html.parser")
            for heading in copy.select("h1,h2,h3,h4,script,style"):
                heading.decompose()
            abstract = abstract_text(copy.get_text(" "))
            if abstract:
                source = selector
                break
    if not abstract:
        for heading in soup.select("h2,h3,h4"):
            if clean(heading.get_text()).lower() != "abstract":
                continue
            parts = []
            for sibling in heading.next_siblings:
                if getattr(sibling, "name", None) in {"h1", "h2", "h3", "h4", "section"}:
                    break
                if getattr(sibling, "name", None) == "p":
                    parts.append(sibling.get_text(" "))
                elif getattr(sibling, "name", None) and sibling.find(["h1", "h2", "h3", "h4"]):
                    break
            abstract = abstract_text(" ".join(parts))
            if abstract:
                source = "paragraphs_after_abstract_heading"
                break
    return {**record, "abstract": abstract, "abstract_source": source,
            "status": "abstract_found" if abstract else "metadata_only"}


def extract_catalog(html, url):
    soup = BeautifulSoup(html, "html.parser")
    rows = {}
    for link in soup.select("a[href]"):
        target = urljoin(url, link["href"]).split("#")[0]
        if not valid_url(target) or urlsplit(target).hostname != urlsplit(url).hostname:
            continue
        doi = doi_from_url(target)
        if not doi and not re.search(r"/(?:science/article/pii|advance-article|article)/", urlsplit(target).path):
            continue
        if re.search(r"/(?:pdf|epdf|suppl)/|\.pdf(?:$|\?)", target, re.I):
            continue
        title = clean(link.get_text(" "))
        if len(title) < 15 or title.lower() in {"abstract", "full text", "view article"}:
            continue
        rows.setdefault(doi or target, {"url": target, "doi": doi, "title": title})
    return list(rows.values())


def recognize_image(image_bytes, digits=True):
    import ddddocr
    # Cache the model in-process, no model reload per page.
    if not hasattr(recognize_image, "engine"):
        recognize_image.engine = ddddocr.DdddOcr(show_ad=False)
    engine = recognize_image.engine
    engine.set_ranges(0 if digits else 6)
    return clean(engine.classification(image_bytes))


def snapshot(driver):
    return driver.execute_script("""
      const visible = e => !!e && e.getBoundingClientRect().width > 0 &&
          e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden';
      return {title:document.title, url:location.href, html:document.documentElement.outerHTML,
        body:(document.body?.innerText || ''), gate:[...document.querySelectorAll(
          'iframe[src*="captcha"],iframe[src*="challenges.cloudflare"],#challenge-running,#challenge-stage')].some(visible)};
    """)


def handle_simple_captcha(driver, config, output):
    """Configured numeric image form only. At most one submit, never generic buttons."""
    required = ("image_selector", "input_selector", "submit_selector")
    if any(not config.get(key) for key in required):
        return "not_configured"
    if urlsplit(driver.current_url).hostname != config.get("host"):
        return "host_mismatch"
    snap = snapshot(driver)
    if snap["gate"] or re.search(r"cloudflare|turnstile|recaptcha|hcaptcha", snap["title"], re.I):
        return "unsupported_browser_challenge"
    try:
        image = driver.find_element(By.CSS_SELECTOR, config["image_selector"])
        field = driver.find_element(By.CSS_SELECTOR, config["input_selector"])
        button = driver.find_element(By.CSS_SELECTOR, config["submit_selector"])
        if not all(el.is_displayed() for el in (image, field, button)):
            return "form_not_visible"
        data = image.screenshot_as_png
        (output / "captcha.png").write_bytes(data)
        answer = recognize_image(data, digits=config.get("digits_only", True))
        pattern = config.get("answer_pattern", r"[0-9]{4,6}")
        if not re.fullmatch(pattern, answer):
            return "ocr_answer_rejected"
        field.clear()
        field.send_keys(answer)
        button.click()
        return "submitted_once"
    except Exception as exc:
        return "ocr_error:" + type(exc).__name__


def create_driver(args):
    # Local browser control must not go through a system HTTP proxy.
    # This only affects this Python process, not Windows or publisher traffic.
    bypass = os.environ.get("NO_PROXY", os.environ.get("no_proxy", ""))
    os.environ["NO_PROXY"] = ",".join(filter(None, [bypass, "127.0.0.1", "localhost", "::1"]))
    os.environ["no_proxy"] = os.environ["NO_PROXY"]
    if args.engine == "cdp":
        from cdp_driver import CDPDriver
        return CDPDriver(args)
    os.environ.setdefault("SE_CACHE_PATH", str(DATA / "drivers"))
    os.environ.setdefault("SE_AVOID_STATS", "true")
    options = webdriver.EdgeOptions() if args.browser == "edge" else webdriver.ChromeOptions()
    options.page_load_strategy = "eager"
    options.add_argument("--window-size=1365,900")
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")
    if args.headless:
        options.add_argument("--headless=new")
    if args.profile:
        options.add_argument("--user-data-dir=" + str(Path(args.profile).resolve()))
    if args.binary:
        options.binary_location = args.binary
    # Browser's normal automation identity is preserved.
    driver = webdriver.Edge(options=options) if args.browser == "edge" else webdriver.Chrome(options=options)
    driver.set_page_load_timeout(args.timeout)
    driver.set_script_timeout(args.timeout)
    return driver


def collect_one(driver, task, args, folder):
    start = time.monotonic()
    record = {"journal": task.get("journal", "custom"), "requested_url": task["url"],
              "kind": task.get("kind", "article"), "started_at": datetime.now(timezone.utc).isoformat(),
              "status": "pending", "captcha_attempt": "not_configured"}
    timed_out = False
    try:
        try:
            driver.get(task["url"])
            WebDriverWait(driver, args.timeout).until(
                lambda d: d.execute_script("return document.readyState") in {"interactive", "complete"})
        except TimeoutException:
            timed_out = True
        time.sleep(args.settle)
        snap = snapshot(driver)
        if task.get("captcha"):
            record["captcha_attempt"] = handle_simple_captcha(driver, task["captcha"], folder)
            if record["captcha_attempt"] == "submitted_once":
                time.sleep(args.settle)
                snap = snapshot(driver)
        status = page_status(snap["title"], snap["body"], snap["gate"])
        provider = challenge_provider(snap["html"], status)
        record["initial_challenge_provider"] = provider
        if status == "needs_verification" and provider == "cloudflare" and args.click_checkbox:
            (folder / "before-verification.html").write_text(snap["html"], encoding="utf-8")
            driver.save_screenshot(str(folder / "before-verification.png"))
            try:
                driver.click_checkbox_once()
                record["captcha_attempt"] = "checkbox_helper_called_once"
                time.sleep(args.settle)
                snap = snapshot(driver)
                status = page_status(snap["title"], snap["body"], snap["gate"])
            except Exception as exc:
                record["captcha_attempt"] = "checkbox_error:" + type(exc).__name__
        if status == "needs_verification" and args.manual_wait and not args.headless:
            print(f"  人机验证：可在浏览器中完成，最多等待 {args.manual_wait:g} 秒。", flush=True)
            deadline = time.monotonic() + args.manual_wait
            while status == "needs_verification" and time.monotonic() < deadline:
                time.sleep(min(5, max(0, deadline - time.monotonic())))
                snap = snapshot(driver)
                status = page_status(snap["title"], snap["body"], snap["gate"])
            if status == "loaded":
                time.sleep(args.settle)
                snap = snapshot(driver)
                status = page_status(snap["title"], snap["body"], snap["gate"])
        record.update(url=snap["url"], page_title=snap["title"], status=status,
                      navigation_timed_out=timed_out,
                      challenge_provider=challenge_provider(snap["html"], status))
        (folder / "page.html").write_text(snap["html"], encoding="utf-8")
        (folder / "page.txt").write_text(snap["body"], encoding="utf-8")
        record["html_sha256"] = hashlib.sha256(snap["html"].encode()).hexdigest()
        try:
            driver.save_screenshot(str(folder / "page.png"))
        except WebDriverException:
            record["screenshot_error"] = True
        if status == "loaded":
            if record["kind"] == "catalog":
                links = extract_catalog(snap["html"], snap["url"])
                record.update(candidates=links, status="catalog_partial" if links else "catalog_unverified",
                              complete=False, coverage_note="只读取指定目录当前一页，不代表全刊完整清单")
            else:
                record.update(extract_article(snap["html"], snap["url"], task))
        if timed_out and record["status"] in {"identity_unverified", "catalog_unverified"}:
            record["status"] = "page_timeout"
    except Exception as exc:
        record.update(status="browser_error", error_type=type(exc).__name__, error=str(exc)[:500])
    record["elapsed_seconds"] = round(time.monotonic() - start, 2)
    record["evidence_directory"] = str(folder)
    return record


LABELS = {"abstract_found": "取得摘要", "metadata_only": "取得元数据，未取得摘要",
          "needs_verification": "仍需人机验证", "access_restricted": "访问受限",
          "identity_unverified": "未能核实论文身份", "identity_conflict": "论文身份冲突",
          "catalog_partial": "取得部分目录", "catalog_unverified": "未取得有效目录",
          "page_timeout": "页面超时", "browser_error": "浏览器错误", "network_error": "网络错误"}


def save_results(output, records, args):
    payload = {"experiment": "selenium-pilot", "engine": args.engine,
               "browser": args.browser, "headless": args.headless,
               "interval_seconds": args.interval, "settle_seconds": args.settle,
               "manual_wait_seconds": args.manual_wait, "records": records,
               "production_imported": False}
    temp = output / "results.tmp"
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(output / "results.json")
    lines = ["Python + Selenium 采集试验", "", "每行是一页的实际结果；未写入正式论文库。", ""]
    for r in records:
        lines += [f"{r['journal']}：{LABELS.get(r['status'], r['status'])}（{r['elapsed_seconds']} 秒）",
                  f"  {r['requested_url']}", f"  标题：{r.get('title') or r.get('page_title', '')}",
                  (f"  目录候选链接数：{len(r.get('candidates', []))}（仅当前页，未证明全刊覆盖）"
                   if r.get("kind") == "catalog" else f"  摘要字符数：{len(r.get('abstract', ''))}")]
    (output / "summary.txt").write_text("\n".join(lines) + "\n", encoding="utf-8-sig")


def main(argv=None):
    parser = argparse.ArgumentParser(description="独立 Python 浏览器采集试验，不改正式论文库")
    parser.add_argument("--config", type=Path, default=HERE / "samples.json")
    parser.add_argument("--url", help="只测试一个 HTTPS 页面")
    parser.add_argument("--doi", default="", help="单页测试的预期 DOI")
    parser.add_argument("--browser", choices=["edge", "chrome"], default="edge")
    parser.add_argument("--engine", choices=["selenium", "cdp"], default="selenium")
    parser.add_argument("--click-checkbox", action="store_true", help="CDP 模式对 Cloudflare 复选框调用一次处理器")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--binary", help="指定浏览器程序路径")
    parser.add_argument("--profile", help="专用于本试验的浏览器配置目录")
    parser.add_argument("--interval", type=float, default=3, help="页面处理结束到下一页的间隔，至少 3 秒")
    parser.add_argument("--settle", type=float, default=5, help="网页初始加载后等待动态内容的秒数")
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--manual-wait", type=float, default=0, help="人机验证时等待你手动操作的秒数")
    parser.add_argument("--limit", type=int, default=3, help="最大页面数，1 至 20")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--ocr-image", type=Path, help="仅用 ddddocr 识别一张本地数字验证码，不访问网页")
    args = parser.parse_args(argv)
    if args.click_checkbox and (args.engine != "cdp" or args.headless):
        parser.error("复选框试验需要可见的 CDP 浏览器")
    if args.ocr_image:
        print(recognize_image(args.ocr_image.read_bytes()))
        return 0
    if not (3 <= args.interval <= 3600 and 0 <= args.settle <= 60 and 1 <= args.timeout <= 120
            and 0 <= args.manual_wait <= 1800 and 1 <= args.limit <= 20):
        parser.error("间隔/等待/页数超出试验范围")
    tasks = ([{"url": args.url, "doi": args.doi, "kind": "article"}] if args.url else
             json.loads(args.config.read_text(encoding="utf-8-sig")))
    if not isinstance(tasks, list) or not tasks:
        parser.error("配置必须是非空页面列表")
    tasks = tasks[:args.limit]
    if any(not isinstance(t, dict) or not valid_url(t.get("url", "")) for t in tasks):
        parser.error("仅支持没有账号密码的 HTTPS 页面地址")
    output = args.output or DATA / "runs" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    print("输出目录：" + str(output), flush=True)
    records = []
    driver = None
    try:
        driver = create_driver(args)
        (output / "browser.json").write_text(json.dumps({k: driver.capabilities.get(k)
            for k in ("browserName", "browserVersion", "platformName")}, indent=2), encoding="utf-8")
        for i, task in enumerate(tasks):
            if i:
                time.sleep(args.interval)
            folder = output / f"{i + 1:02d}"
            folder.mkdir()
            print(f"[{i+1}/{len(tasks)}] {task.get('journal', '')} {task['url']}", flush=True)
            records.append(collect_one(driver, task, args, folder))
            save_results(output, records, args)
            print("  " + LABELS.get(records[-1]["status"], records[-1]["status"]), flush=True)
    except KeyboardInterrupt:
        print("已停止；完成页面的结果已保留。", flush=True)
        return 130
    except Exception as exc:
        (output / "startup-error.txt").write_text(str(exc), encoding="utf-8")
        print("启动失败：" + str(exc)[:700], file=sys.stderr)
        return 1
    finally:
        if driver:
            try:
                driver.quit()
            except WebDriverException:
                pass
    print("结果：" + str(output / "summary.txt"), flush=True)
    return 0 if all(r["status"] in {"abstract_found", "metadata_only", "catalog_partial"} for r in records) else 2


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
