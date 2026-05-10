#!/usr/bin/env python3
"""One-off / repeatable: fill questionRu (PT→RU) for FLE tests via MyMemory API."""
from __future__ import annotations

import argparse
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / "public" / "course" / "fle-tests.json"
CACHE: dict[str, str] = {}
SLEEP_S = 0.35
BLANK_TOKEN = "***"


def cyr_ratio(s: str) -> float:
    if not s:
        return 1.0
    c = sum(1 for ch in s if "\u0400" <= ch <= "\u04ff")
    return c / len(s)


def translate_pt_ru(text: str) -> str:
    text = text.strip()
    if text in CACHE:
        return CACHE[text]
    url = (
        "https://api.mymemory.translated.net/get?q="
        + urllib.parse.quote(text[:480])
        + "&langpair=pt|ru"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "PortuPrep-fle-fill/1"})
    data = None
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read().decode())
            break
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 5:
                time.sleep(2.5 * (attempt + 1))
                continue
            raise
    if data is None or data.get("responseStatus") != 200:
        raise RuntimeError(str(data)[:300] if data else "no response")
    out = str(data["responseData"]["translatedText"]).strip()
    CACHE[text] = out
    return out


def prep_question_for_translate(q: str) -> tuple[str, bool]:
    """Replace blank markers so MT does not read 'Eu' as English 'I'."""
    if "___" in q:
        return re.sub(r"_{3,}", BLANK_TOKEN, q), True
    return q, False


def post_question_ru(raw: str, had_blank: bool) -> str:
    s = raw.strip()
    if had_blank:
        s = re.sub(re.escape(BLANK_TOKEN) + r"+", "___", s)
    s = re.sub(r"\bI\b", "Я", s)
    s = re.sub(r"\bShe\b", "Она", s)
    s = re.sub(r"\bHe\b", "Он", s)
    s = re.sub(r"\bWe\b", "Мы", s)
    s = re.sub(r"\bThey\b", "Они", s)
    return s


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--force",
        action="store_true",
        help="Перезаписать уже существующие questionRu (кроме conjugation и кириллических вопросов).",
    )
    args = ap.parse_args()

    data = json.loads(PATH.read_text(encoding="utf-8"))
    filled = 0
    skipped = 0
    errors = 0
    for t in data["tests"]:
        if t.get("questionRu") and not args.force:
            skipped += 1
            continue
        if t.get("testType") == "conjugation":
            if "questionRu" in t:
                del t["questionRu"]
            skipped += 1
            continue
        q = (t.get("question") or "").strip()
        if not q:
            skipped += 1
            continue
        if cyr_ratio(q) > 0.32:
            if "questionRu" in t and args.force:
                del t["questionRu"]
            skipped += 1
            continue
        try:
            q_send, had_blank = prep_question_for_translate(q)
            raw = translate_pt_ru(q_send)
            t["questionRu"] = post_question_ru(raw, had_blank)
            filled += 1
            if filled % 25 == 0:
                print(filled, "…", flush=True)
        except Exception as e:
            print("ERR", t.get("id"), e, flush=True)
            errors += 1
        time.sleep(SLEEP_S)
    PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("filled", filled, "skipped", skipped, "errors", errors)


if __name__ == "__main__":
    main()
