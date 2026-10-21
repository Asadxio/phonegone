import os
import re
import sys
import json
import time
import socket
import urllib.request
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, HTTPServer

CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 8765
CDP_PORT = 9222
TARGET_DIR = r"c:\Users\xioas\Downloads\phonegone-prototype\phonegone"

results = {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "details": []
}

def record_test(name, success, info=""):
    results["total"] += 1
    if success:
        results["passed"] += 1
        results["details"].append(f"[PASS] {name}" + (f": {info}" if info else ""))
        print(f"  ✓ {name}" + (f" ({info})" if info else ""))
    else:
        results["failed"] += 1
        results["details"].append(f"[FAIL] {name}: {info}")
        print(f"  ✗ {name}: {info}")

def run_static_tests():
    print("\n--- Running Static & Code Quality Checks ---")
    index_path = os.path.join(TARGET_DIR, "index.html")
    with open(index_path, "r", encoding="utf-8") as f:
        html = f.read()

    # 1. HTML5 DOCTYPE & semantic tags
    record_test("HTML5 DOCTYPE present", html.startswith("<!doctype html>"))
    record_test("Semantic landmark elements", all(tag in html for tag in ["<header", "<nav", "<main", "<section", "<footer", "<aside"]))
    record_test("Skip to main content link", 'class="skip-link"' in html and 'href="#main-content"' in html)

    # 2. Meta and SEO tags
    record_test("Viewport meta tag", 'name="viewport"' in html and "width=device-width" in html)
    record_test("Theme color meta tag", 'name="theme-color"' in html and "#043629" in html)
    record_test("OpenGraph metadata", all(og in html for og in ["og:title", "og:description", "og:type", "og:url", "og:locale"]))
    record_test("Twitter Card metadata", "twitter:card" in html and "twitter:title" in html)
    record_test("Favicon and Manifest linked", 'href="favicon.svg"' in html and 'href="manifest.webmanifest"' in html)

    # 3. Security: Target blank links must have rel="noopener noreferrer"
    blank_links = re.findall(r'<a\s+[^>]*target=["\']_blank["\'][^>]*>', html)
    unsafe_links = [l for l in blank_links if 'rel="noopener noreferrer"' not in l and "rel='noopener noreferrer'" not in l]
    record_test("External link security (target=_blank has noopener noreferrer)", len(unsafe_links) == 0, f"{len(blank_links)} links checked, {len(unsafe_links)} unsafe")

    # 4. Zero third-party script / stylesheet tags
    external_scripts = re.findall(r'<script\s+[^>]*src=["\'](http[s]?://[^"\']+)["\']', html)
    external_styles = re.findall(r'<link\s+[^>]*rel=["\']stylesheet["\'][^>]*href=["\'](http[s]?://[^"\']+)["\']', html)
    record_test("Zero external script dependencies", len(external_scripts) == 0, f"Found {external_scripts}")
    record_test("Zero external stylesheet/font dependencies", len(external_styles) == 0, f"Found {external_styles}")

    # 5. Internationalization completeness
    en_block = html[html.find("en: {"):html.find("hi: {")]
    hi_block = html[html.find("hi: {"):html.find("const STEPS =")]
    en_keys = set(re.findall(r'^\s{10}(\w+):', en_block, re.M))
    hi_keys = set(re.findall(r'^\s{10}(\w+):', hi_block, re.M))
    missing_hi = en_keys - hi_keys
    record_test("Bilingual parity (all English keys have Hindi equivalent)", len(missing_hi) == 0, f"Missing: {missing_hi}")

    # 6. Verification of static ancillary files
    record_test("robots.txt exists", os.path.exists(os.path.join(TARGET_DIR, "robots.txt")))
    record_test("sitemap.xml exists", os.path.exists(os.path.join(TARGET_DIR, "sitemap.xml")))
    record_test("favicon.svg exists", os.path.exists(os.path.join(TARGET_DIR, "favicon.svg")))
    record_test("manifest.webmanifest exists", os.path.exists(os.path.join(TARGET_DIR, "manifest.webmanifest")))
    record_test("404.html exists", os.path.exists(os.path.join(TARGET_DIR, "404.html")))

def run_browser_tests():
    print("\n--- Running Real Headless Browser Tests (Chrome) ---")
    
def run_browser_tests():
    print("\n--- Running Real Headless Browser Tests (Node CDP) ---")
    proc = subprocess.run(["node", "test_browser.mjs"], cwd=os.path.dirname(__file__) or ".", capture_output=True, text=True)
    print(proc.stdout)
    if proc.stderr:
        print(proc.stderr)
    record_test("Browser headless tests (21 assertions)", proc.returncode == 0, f"Exit code {proc.returncode}")

if __name__ == "__main__":
    print("=" * 60)
    print(" PHONEGONE TEST SUITE")
    print("=" * 60)
    run_static_tests()
    run_browser_tests()
    print("\n" + "=" * 60)
    print(f" SUMMARY: {results['passed']} / {results['total']} tests passed ({results['failed']} failed)")
    print("=" * 60)
    sys.exit(0 if results['failed'] == 0 else 1)
