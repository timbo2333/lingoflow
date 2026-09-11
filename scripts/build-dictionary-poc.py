#!/usr/bin/env python3
"""Build a deterministic Dictionary 2.0 PoC dataset from repository data."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import tempfile
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
DICTIONARY_DIR = REPO / "data" / "dictionary"
MANIFEST_PATH = DICTIONARY_DIR / "manifest.json"
LEMMA_PATH = DICTIONARY_DIR / "lemma.en.txt"
RULE_VERSION = "dictionary-cloud-poc-v1"
EXAM_TAGS = {"zk", "gk", "cet4", "cet6", "ky", "toefl", "ielts", "gre"}
APOSTROPHES = str.maketrans({
    "\u2018": "'", "\u2019": "'", "\u201b": "'", "\u02bc": "'",
    "\uff07": "'", "\u2032": "'",
})
DASHES = str.maketrans({
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-",
    "\u2014": "-", "\u2015": "-", "\u2212": "-", "\ufe58": "-",
    "\ufe63": "-", "\uff0d": "-",
})
VALID_HEADWORD = re.compile(r"^[a-z]+(?:['-][a-z]+)*$")
LOW_VALUE_TRANSLATION = re.compile(r"\[(?:人名|地名|商标)\]")
LONG_TRANSLATION_BYTES = 200


def canonicalize(value: str) -> tuple[str, str]:
    normalized = (
        unicodedata.normalize("NFKC", str(value or ""))
        .translate(APOSTROPHES)
        .translate(DASHES)
        .strip()
        .lower()
    )
    canonical = normalized
    while canonical and unicodedata.category(canonical[0]).startswith("P"):
        canonical = canonical[1:]
    while canonical and unicodedata.category(canonical[-1]).startswith("P"):
        canonical = canonical[:-1]
    return canonical, normalized


def positive_int(value: str) -> int:
    try:
        return max(0, int((value or "0").strip() or 0))
    except ValueError:
        return 0


def read_lemma_signals() -> tuple[dict[str, int], dict[str, set[str]]]:
    frequencies: dict[str, int] = {}
    form_lemmas: dict[str, set[str]] = defaultdict(set)

    with LEMMA_PATH.open(encoding="utf-8") as source:
        for raw_line in source:
            line = raw_line.strip()
            if not line or line.startswith(";") or "->" not in line:
                continue
            left, right = line.split("->", 1)
            lemma_text = left.strip()
            frequency = 0
            if "/" in lemma_text:
                maybe_lemma, maybe_frequency = lemma_text.rsplit("/", 1)
                if maybe_frequency.strip().isdigit():
                    lemma_text = maybe_lemma.strip()
                    frequency = int(maybe_frequency.strip())
            lemma, normalized = canonicalize(lemma_text)
            if not lemma or lemma != normalized or not VALID_HEADWORD.fullmatch(lemma):
                continue
            frequencies[lemma] = max(frequencies.get(lemma, 0), frequency)
            for form_text in [lemma_text, *right.split(",")]:
                form, form_normalized = canonicalize(form_text.strip())
                if form and form == form_normalized and VALID_HEADWORD.fullmatch(form):
                    form_lemmas[form].add(lemma)

    return frequencies, form_lemmas


def ranking_key(entry: dict) -> tuple:
    signals = entry["signals"]
    exam_weight = sum({
        "zk": 4, "gk": 5, "cet4": 7, "cet6": 7, "ky": 7,
        "toefl": 8, "ielts": 8, "gre": 6,
    }.get(tag, 2) for tag in signals["tags"])
    source_count = sum([
        signals["frq"] > 0,
        signals["bnc"] > 0,
        signals["oxford"],
        signals["collins"],
        bool(signals["tags"]),
        signals["lemma_frequency"] > 0,
    ])
    frequency_rank = min([
        value for value in (signals["frq"], signals["bnc"]) if value > 0
    ] or [10**9])
    return (
        -source_count,
        -int(signals["oxford"]),
        -int(signals["collins"]),
        -exam_weight,
        frequency_rank,
        -signals["lemma_frequency"],
        entry["word"],
    )


def read_candidates() -> tuple[list[dict], dict[str, set[str]], Counter]:
    lemma_frequencies, form_lemmas = read_lemma_signals()
    canonical_counts: Counter = Counter()
    signal_rows = []

    for chunk in sorted(DICTIONARY_DIR.glob("ecdict-*.csv")):
        with chunk.open(encoding="utf-8-sig", newline="") as source:
            for row in csv.DictReader(source):
                canonical, normalized = canonicalize(row.get("word") or "")
                if canonical:
                    canonical_counts[canonical] += 1

                translation = row.get("translation") or ""
                if (not canonical or canonical != normalized or
                        not VALID_HEADWORD.fullmatch(canonical) or
                        len(canonical) > 50 or not translation.strip() or
                        LOW_VALUE_TRANSLATION.search(translation)):
                    continue

                tags = set((row.get("tag") or "").strip().lower().split())
                collins = bool((row.get("collins") or "").strip())
                signals = {
                    "frq": positive_int(row.get("frq") or "0"),
                    "bnc": positive_int(row.get("bnc") or "0"),
                    "oxford": bool((row.get("oxford") or "").strip()),
                    "collins": collins,
                    "tags": tags,
                    "lemma_frequency": lemma_frequencies.get(canonical, 0),
                }
                if not any([
                    signals["frq"] > 0,
                    signals["bnc"] > 0,
                    signals["oxford"],
                    signals["collins"],
                    bool(signals["tags"]),
                    signals["lemma_frequency"] > 0,
                ]):
                    continue

                signal_rows.append({
                    "word": canonical,
                    "phonetic": row.get("phonetic") or "",
                    "translation": translation,
                    "pos": row.get("pos") or "",
                    "signals": signals,
                })

    candidates = [
        entry for entry in signal_rows if canonical_counts[entry["word"]] == 1
    ]
    candidates.sort(key=ranking_key)
    return candidates, form_lemmas, canonical_counts


def select_dataset(candidates: list[dict], form_lemmas: dict[str, set[str]], limit: int) -> list[dict]:
    selected = []
    selected_words = set()

    def take(label: str, count: int, predicate) -> None:
        taken = 0
        for entry in candidates:
            if taken >= count:
                break
            if entry["word"] in selected_words or not predicate(entry):
                continue
            entry["selection_reason"] = label
            selected.append(entry)
            selected_words.add(entry["word"])
            taken += 1

    take("multi-signal common", 100, lambda item: sum([
        item["signals"]["frq"] > 0,
        item["signals"]["bnc"] > 0,
        item["signals"]["oxford"],
        item["signals"]["collins"],
        bool(item["signals"]["tags"]),
        item["signals"]["lemma_frequency"] > 0,
    ]) >= 3)
    take("IELTS", 40, lambda item: "ielts" in item["signals"]["tags"])
    take("TOEFL", 35, lambda item: "toefl" in item["signals"]["tags"])
    take("GRE", 35, lambda item: "gre" in item["signals"]["tags"])
    take("phonetic nullable", 45, lambda item: not item["phonetic"].strip())
    take("lemma or inflection", 40, lambda item: any(
        lemma != item["word"] for lemma in form_lemmas.get(item["word"], set())
    ))
    take("apostrophe or hyphen", 15, lambda item: bool(re.search(r"['-]", item["word"])))
    take("long normal translation", 30, lambda item: len(
        item["translation"].encode("utf-8")
    ) >= LONG_TRANSLATION_BYTES)
    take("ranked fill", limit, lambda _item: True)

    selected = selected[:limit]
    selected.sort(key=lambda item: item["word"])
    return selected


def sql_literal(value: str | None) -> str:
    if value is None or value == "":
        return "null"
    return "'" + value.replace("'", "''") + "'"


def write_outputs(
    output_dir: Path,
    selected: list[dict],
    form_lemmas: dict[str, set[str]],
    manifest: dict,
    seed_file: Path | None,
) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    csv_path = output_dir / "dictionary-poc.csv"
    report_path = output_dir / "dictionary-poc-report.json"
    sql_path = output_dir / "dictionary-poc-import.sql"

    with csv_path.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=["word", "phonetic", "translation", "pos"])
        writer.writeheader()
        for entry in selected:
            writer.writerow({key: entry[key] for key in writer.fieldnames})

    values = []
    for entry in selected:
        values.append("(" + ", ".join([
            sql_literal(entry["word"]),
            sql_literal(entry["phonetic"]),
            sql_literal(entry["translation"]),
            sql_literal(entry["pos"]),
        ]) + ")")
    sql = (
        "begin;\n"
        "insert into public.dictionary_entries (word, phonetic, translation, pos) values\n  "
        + ",\n  ".join(values)
        + "\non conflict (word) do update set\n"
        "  phonetic = excluded.phonetic,\n"
        "  translation = excluded.translation,\n"
        "  pos = excluded.pos;\n"
        "commit;\n"
    )
    sql_path.write_text(sql, encoding="utf-8")
    if seed_file:
        seed_file.parent.mkdir(parents=True, exist_ok=True)
        seed_file.write_text(sql, encoding="utf-8")

    reason_counts = Counter(entry["selection_reason"] for entry in selected)
    exam_counts = Counter()
    for entry in selected:
        exam_counts.update(entry["signals"]["tags"] & EXAM_TAGS)
    digest = hashlib.sha256(csv_path.read_bytes()).hexdigest()
    report = {
        "source_dictionary_version": manifest["dictionaryVersion"],
        "candidate_rule_version": RULE_VERSION,
        "included_count": len(selected),
        "csv_sha256": digest,
        "selection_reasons": dict(sorted(reason_counts.items())),
        "exam_tag_counts": dict(sorted(exam_counts.items())),
        "phonetic_null_count": sum(not item["phonetic"].strip() for item in selected),
        "pos_null_count": sum(not item["pos"].strip() for item in selected),
        "apostrophe_or_hyphen_count": sum(bool(re.search(r"['-]", item["word"])) for item in selected),
        "long_translation_count": sum(
            len(item["translation"].encode("utf-8")) >= LONG_TRANSLATION_BYTES
            for item in selected
        ),
        "lemma_or_inflection_count": sum(any(
            lemma != item["word"] for lemma in form_lemmas.get(item["word"], set())
        ) for item in selected),
        "outputs": {
            "csv": str(csv_path),
            "report": str(report_path),
            "sql": str(sql_path),
            "seed": str(seed_file) if seed_file else None,
        },
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=400)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--seed-file", type=Path)
    args = parser.parse_args()
    if not 300 <= args.limit <= 500:
        parser.error("--limit must be between 300 and 500")

    output_dir = args.output_dir or Path(tempfile.mkdtemp(prefix="lingoflow-dictionary-poc."))
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    candidates, form_lemmas, _canonical_counts = read_candidates()
    selected = select_dataset(candidates, form_lemmas, args.limit)
    if len(selected) != args.limit:
        raise RuntimeError(f"Only {len(selected)} eligible PoC entries were available")
    report = write_outputs(output_dir, selected, form_lemmas, manifest, args.seed_file)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
