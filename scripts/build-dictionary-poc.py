#!/usr/bin/env python3
"""Build deterministic Dictionary 2.0 PoC or high-confidence Core snapshots."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import tempfile
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable


REPO = Path(__file__).resolve().parents[1]
DICTIONARY_DIR = REPO / "data" / "dictionary"
MANIFEST_PATH = DICTIONARY_DIR / "manifest.json"
LEMMA_PATH = DICTIONARY_DIR / "lemma.en.txt"
POC_RULE_VERSION = "dictionary-cloud-poc-v1"
CORE_RULE_VERSION = "dictionary-core-high-confidence-v1"
POC_DEFAULT_LIMIT = 400
CORE_DEFAULT_LIMIT = 60_000
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
ASCII_LETTER = re.compile(r"[A-Za-z]")
LOW_VALUE_TRANSLATION = re.compile(r"\[(?:人名|地名|商标)\]")
POLLUTED_KEY = re.compile(r"(?:https?://|www\.|@|[/\\_=<>])", re.IGNORECASE)
LONG_TRANSLATION_BYTES = 200
CSV_FIELDS = ["word", "phonetic", "translation", "pos"]
REJECTION_REASONS = (
    "empty_word",
    "numeric_key",
    "no_ascii_english_letter",
    "multi_word_or_sentence",
    "headword_too_long",
    "polluted_key",
    "peripheral_punctuation",
    "invalid_internal_format",
    "translation_empty",
    "low_value_name_place_or_brand",
    "no_ranking_signal",
    "canonical_collision",
)


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


def read_lemma_signals(
    lemma_path: Path = LEMMA_PATH,
) -> tuple[dict[str, int], dict[str, set[str]]]:
    frequencies: dict[str, int] = {}
    form_lemmas: dict[str, set[str]] = defaultdict(set)

    with lemma_path.open(encoding="utf-8") as source:
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


def signal_source_count(signals: dict) -> int:
    return sum([
        signals["frq"] > 0,
        signals["bnc"] > 0,
        signals["oxford"],
        signals["collins"],
        bool(signals["tags"]),
        signals["lemma_frequency"] > 0,
    ])


def ranking_key(entry: dict) -> tuple:
    signals = entry["signals"]
    exam_weight = sum({
        "zk": 4, "gk": 5, "cet4": 7, "cet6": 7, "ky": 7,
        "toefl": 8, "ielts": 8, "gre": 6,
    }.get(tag, 2) for tag in signals["tags"])
    frequency_rank = min([
        value for value in (signals["frq"], signals["bnc"]) if value > 0
    ] or [10**9])
    return (
        -signal_source_count(signals),
        -int(signals["oxford"]),
        -int(signals["collins"]),
        -exam_weight,
        frequency_rank,
        -signals["lemma_frequency"],
        entry["word"],
    )


def rejection_reason(raw_word: str, canonical: str, normalized: str, translation: str) -> str | None:
    stripped_word = str(raw_word or "").strip()
    if not stripped_word:
        return "empty_word"
    if stripped_word.isdigit():
        return "numeric_key"
    if not ASCII_LETTER.search(stripped_word):
        return "no_ascii_english_letter"
    if any(character.isspace() for character in normalized):
        return "multi_word_or_sentence"
    if len(canonical) > 50:
        return "headword_too_long"
    if POLLUTED_KEY.search(normalized):
        return "polluted_key"
    if canonical != normalized:
        return "peripheral_punctuation"
    if not VALID_HEADWORD.fullmatch(canonical):
        return "invalid_internal_format"
    if not translation.strip():
        return "translation_empty"
    if LOW_VALUE_TRANSLATION.search(translation):
        return "low_value_name_place_or_brand"
    return None


def read_candidates() -> tuple[list[dict], dict[str, set[str]], dict]:
    lemma_frequencies, form_lemmas = read_lemma_signals()
    canonical_counts: Counter = Counter()
    rejected_counts: Counter = Counter({reason: 0 for reason in REJECTION_REASONS})
    signal_rows = []
    source_record_count = 0

    for chunk in sorted(DICTIONARY_DIR.glob("ecdict-*.csv")):
        with chunk.open(encoding="utf-8-sig", newline="") as source:
            for row in csv.DictReader(source):
                source_record_count += 1
                raw_word = row.get("word") or ""
                canonical, normalized = canonicalize(raw_word)
                if canonical:
                    canonical_counts[canonical] += 1

                translation = row.get("translation") or ""
                reason = rejection_reason(raw_word, canonical, normalized, translation)
                if reason:
                    rejected_counts[reason] += 1
                    continue

                tags = set((row.get("tag") or "").strip().lower().split()) & EXAM_TAGS
                signals = {
                    "frq": positive_int(row.get("frq") or "0"),
                    "bnc": positive_int(row.get("bnc") or "0"),
                    "oxford": bool((row.get("oxford") or "").strip()),
                    "collins": bool((row.get("collins") or "").strip()),
                    "tags": tags,
                    "lemma_frequency": lemma_frequencies.get(canonical, 0),
                }
                if signal_source_count(signals) == 0:
                    rejected_counts["no_ranking_signal"] += 1
                    continue

                signal_rows.append({
                    "word": canonical,
                    "phonetic": row.get("phonetic") or "",
                    "translation": translation,
                    "pos": row.get("pos") or "",
                    "signals": signals,
                })

    collision_keys = {
        word for word, count in canonical_counts.items() if count > 1
    }
    candidates = []
    for entry in signal_rows:
        if entry["word"] in collision_keys:
            rejected_counts["canonical_collision"] += 1
        else:
            candidates.append(entry)
    candidates.sort(key=ranking_key)

    stats = {
        "source_record_count": source_record_count,
        "rejected_counts": rejected_counts,
        "canonical_collision_count": len(collision_keys),
        "canonical_collision_entry_count": sum(
            count for count in canonical_counts.values() if count > 1
        ),
        "collision_keys": collision_keys,
        "signal_backed_candidate_count": len(candidates),
    }
    return candidates, form_lemmas, stats


def select_poc_dataset(
    candidates: list[dict],
    form_lemmas: dict[str, set[str]],
    limit: int,
) -> list[dict]:
    selected = []
    selected_words = set()

    def take(label: str, count: int, predicate: Callable[[dict], bool]) -> None:
        taken = 0
        for entry in candidates:
            if taken >= count:
                break
            if entry["word"] in selected_words or not predicate(entry):
                continue
            selected.append({**entry, "selection_reason": label})
            selected_words.add(entry["word"])
            taken += 1

    take("multi-signal common", 100, lambda item: signal_source_count(item["signals"]) >= 3)
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
    return sorted(selected[:limit], key=lambda item: item["word"])


def select_core_dataset(candidates: list[dict], limit: int) -> list[dict]:
    return sorted([
        {**entry, "selection_reason": "ranked signal-backed core"}
        for entry in candidates[:limit]
    ], key=lambda item: item["word"])


# ----- Core Lemma Pack (independent rebuildable public resource) -----

CORE_LEMMA_PACK_FORMAT_VERSION = "1"
CORE_LEMMA_PACK_VERSION = "core-lemma-pack-v1"
CORE_LEMMA_PACK_DICTIONARY_DATA_VERSION = "core-2026-08-16-e15991ce6e92"
CORE_LEMMA_PACK_FILENAME = "core-lemma-candidates.json"
CORE_LEMMA_MANIFEST_FILENAME = "core-lemma-manifest.json"


def build_core_lemma_pack(
    core_csv_path: Path,
    lemma_en_path: Path,
    output_dir: Path,
) -> tuple[Path, Path, dict]:
    """Build the deterministic Core Lemma Pack.

    The pack maps each surface form to a list of candidate lemmas whose canonical
    lemma is present in the 60k Core Dictionary. A form may keep multiple candidates
    (ambiguity is preserved). Output is byte-deterministic given the same inputs.
    """
    if not core_csv_path.is_file():
        raise RuntimeError(
            f"Core dictionary CSV not found at {core_csv_path}. "
            "Run `--mode core --output-dir <temporary-output-dir>` first."
        )
    if not lemma_en_path.is_file():
        raise RuntimeError(f"lemma.en.txt not found at {lemma_en_path}")

    # 1. Read 60k Core headwords from the CSV produced by `--mode core`.
    core_set: set[str] = set()
    core_row_count = 0
    with core_csv_path.open(encoding="utf-8", newline="") as source:
        reader = csv.DictReader(source)
        for row in reader:
            word = (row.get("word") or "").strip()
            if not word or not VALID_HEADWORD.fullmatch(word):
                continue
            core_set.add(word)
            core_row_count += 1
    if not core_set:
        raise RuntimeError("Core dictionary CSV did not yield any valid headwords.")

    # 2. Parse lemma.en.txt using the same builder canonicalize rules
    #    that 60k Core uses, so form/lemma equivalence holds across both.
    lemma_frequencies, form_lemmas = read_lemma_signals(lemma_en_path)

    # 3. Build a deterministic form -> sorted-candidates index.
    #    Within a form: candidates sorted by lemma frequency desc, then lemma asc.
    form_index: dict[str, list[tuple[str, int]]] = {}
    for form, lemmas in sorted(form_lemmas.items()):
        seen: set[str] = set()
        candidates: list[tuple[str, int]] = []
        for lemma in sorted(
            lemmas,
            key=lambda name: (-lemma_frequencies.get(name, 0), name),
        ):
            if lemma in seen:
                continue
            seen.add(lemma)
            candidates.append((lemma, lemma_frequencies.get(lemma, 0)))
        if candidates:
            form_index[form] = candidates

    # 4. Filter: keep only candidates whose canonical lemma is in 60k Core.
    #    Drop forms whose entire candidate set falls outside Core.
    filtered: dict[str, list[tuple[str, int]]] = {}
    dropped_all_candidates_excluded = 0
    for form in sorted(form_index):
        kept = [
            (lemma, frequency)
            for (lemma, frequency) in form_index[form]
            if lemma in core_set
        ]
        if not kept:
            dropped_all_candidates_excluded += 1
            continue
        filtered[form] = kept

    # 5. Emit compact map format: { form: [[lemma, freq], ...] }
    pack_dict: dict[str, list[list[int | str]]] = {
        form: [[lemma, frequency] for lemma, frequency in cands]
        for form, cands in filtered.items()
    }

    # Use deterministic compact JSON: sorted keys, no whitespace, ensure_ascii
    # off is safe because all form/lemma strings are ASCII (validated upstream).
    output_dir.mkdir(parents=True, exist_ok=True)
    pack_path = output_dir / CORE_LEMMA_PACK_FILENAME
    pack_text = (
        json.dumps(
            pack_dict,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    )
    pack_path.write_text(pack_text, encoding="utf-8")

    # 6. Manifest binds pack to a specific Core snapshot + dictionary data version.
    pack_bytes = pack_path.read_bytes()
    pack_sha256 = hashlib.sha256(pack_bytes).hexdigest()
    lemma_source_sha256 = hashlib.sha256(lemma_en_path.read_bytes()).hexdigest()
    import gzip as _gzip
    gz_bytes = _gzip.compress(pack_bytes, compresslevel=9)

    entry_count = len(pack_dict)
    candidate_pair_count = sum(len(c) for c in pack_dict.values())
    ambiguous_form_count = sum(1 for c in pack_dict.values() if len(c) > 1)

    manifest = {
        "formatVersion": CORE_LEMMA_PACK_FORMAT_VERSION,
        "lemmaPackVersion": CORE_LEMMA_PACK_VERSION,
        "dictionaryDataVersion": CORE_LEMMA_PACK_DICTIONARY_DATA_VERSION,
        "coreRule": CORE_RULE_VERSION,
        "coreSnapshotSha256": hashlib.sha256(core_csv_path.read_bytes()).hexdigest(),
        "lemmaSourceSha256": lemma_source_sha256,
        "coreSnapshotCsvSizeBytes": core_csv_path.stat().st_size,
        "coreHeadwordCount": len(core_set),
        "packFilename": CORE_LEMMA_PACK_FILENAME,
        "manifestFilename": CORE_LEMMA_MANIFEST_FILENAME,
        "packSha256": pack_sha256,
        "packSizeBytes": len(pack_bytes),
        "packGzipSizeBytes": len(gz_bytes),
        "entryCount": entry_count,
        "candidatePairCount": candidate_pair_count,
        "ambiguousFormCount": ambiguous_form_count,
        "maxCandidatesPerForm": max(
            (len(c) for c in pack_dict.values()), default=0
        ),
        "buildRule": (
            "for each lemma.en.txt form (builder-canonicalized + VALID_HEADWORD), "
            "keep candidates whose canonical lemma is present in the 60k Core "
            "snapshot; deduplicate identical form/lemma pairs; never collapse "
            "form -> single lemma; sort candidates by lemma frequency desc, then "
            "lemma code-point order."
        ),
    }

    manifest_path = output_dir / CORE_LEMMA_MANIFEST_FILENAME
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    # Sanity self-check (would fail the build loudly if mismatched).
    expected_dv = CORE_LEMMA_PACK_DICTIONARY_DATA_VERSION
    if manifest["dictionaryDataVersion"] != expected_dv:
        raise RuntimeError(
            f"Manifest dictionaryDataVersion mismatch: "
            f"{manifest['dictionaryDataVersion']} != {expected_dv}"
        )

    return pack_path, manifest_path, {
        "core_row_count": core_row_count,
        "core_headword_count": len(core_set),
        "entry_count": entry_count,
        "candidate_pair_count": candidate_pair_count,
        "ambiguous_form_count": ambiguous_form_count,
        "dropped_all_candidates_excluded": dropped_all_candidates_excluded,
        "pack_size_bytes": len(pack_bytes),
        "pack_gzip_size_bytes": len(gz_bytes),
        "pack_sha256": pack_sha256,
        "manifest": manifest,
    }


def sql_literal(value: str | None) -> str:
    if value is None or value == "":
        return "null"
    return "'" + value.replace("'", "''") + "'"


def content_md5(entries: list[dict]) -> str:
    digest = hashlib.md5(usedforsecurity=False)
    for entry in sorted(entries, key=lambda item: item["word"]):
        digest.update("\x1f".join([
            entry["word"],
            entry["phonetic"] or "",
            entry["translation"],
            entry["pos"] or "",
        ]).encode("utf-8"))
        digest.update(b"\x1e")
    return digest.hexdigest()


def insert_statements(table: str, entries: list[dict], batch_size: int = 500) -> list[str]:
    statements = []
    for offset in range(0, len(entries), batch_size):
        values = []
        for entry in entries[offset:offset + batch_size]:
            values.append("(" + ", ".join([
                sql_literal(entry["word"]),
                sql_literal(entry["phonetic"]),
                sql_literal(entry["translation"]),
                sql_literal(entry["pos"]),
            ]) + ")")
        statements.append(
            f"insert into {table} (word, phonetic, translation, pos) values\n  "
            + ",\n  ".join(values)
            + ";"
        )
    return statements


def verification_block(table: str, entries: list[dict], expected_md5: str, label: str) -> str:
    delimiter = f"$verify_{label}$"
    expected_count = len(entries)
    expected_phonetic_null = sum(not item["phonetic"] for item in entries)
    expected_pos_null = sum(not item["pos"] for item in entries)
    return f"""do {delimiter}
declare
  actual_count bigint;
  actual_md5 text;
  actual_phonetic_null bigint;
  actual_pos_null bigint;
begin
  select
    count(*),
    md5(string_agg(
      word || chr(31) || coalesce(phonetic, '') || chr(31) ||
      translation || chr(31) || coalesce(pos, '') || chr(30),
      '' order by word collate "C"
    )),
    count(*) filter (where phonetic is null),
    count(*) filter (where pos is null)
  into actual_count, actual_md5, actual_phonetic_null, actual_pos_null
  from {table};

  if actual_count <> {expected_count} or actual_md5 <> '{expected_md5}' then
    raise exception '{label} dictionary snapshot verification failed';
  end if;
  if actual_phonetic_null <> {expected_phonetic_null} or actual_pos_null <> {expected_pos_null} then
    raise exception '{label} dictionary nullable-field verification failed';
  end if;
  if exists (
    select 1 from {table}
    where word is null or btrim(word) = '' or
          translation is null or btrim(translation) = ''
  ) then
    raise exception '{label} dictionary required-field verification failed';
  end if;
  if exists (select word from {table} group by word having count(*) > 1) then
    raise exception '{label} dictionary duplicate-word verification failed';
  end if;
end
{delimiter};"""


def build_import_sql(mode: str, entries: list[dict], expected_md5: str) -> str:
    if mode == "poc":
        values = insert_statements("public.dictionary_entries", entries)
        upserts = [statement[:-1] + "\non conflict (word) do update set\n"
                   "  phonetic = excluded.phonetic,\n"
                   "  translation = excluded.translation,\n"
                   "  pos = excluded.pos;" for statement in values]
        return "begin;\n" + "\n".join(upserts) + "\ncommit;\n"

    stage = "dictionary_core_stage"
    statements = [
        "begin;",
        f"create temporary table {stage} (like public.dictionary_entries including all) on commit drop;",
        *insert_statements(stage, entries),
        verification_block(stage, entries, expected_md5, "stage"),
        "truncate table public.dictionary_entries;",
        "insert into public.dictionary_entries (word, phonetic, translation, pos)\n"
        f"select word, phonetic, translation, pos from {stage} order by word;",
        verification_block("public.dictionary_entries", entries, expected_md5, "final"),
        "commit;",
    ]
    return "\n".join(statements) + "\n"


def write_management_api_bundle(
    output_dir: Path,
    entries: list[dict],
    expected_md5: str,
    batch_size: int = 4_000,
) -> list[Path]:
    deploy_dir = output_dir / "core-dictionary-deploy"
    deploy_dir.mkdir(parents=True, exist_ok=True)
    stage = f"public.dictionary_entries_stage_{expected_md5[:8]}"
    create_path = deploy_dir / "000-create-stage.sql"
    create_path.write_text(
        "begin;\n"
        f"drop table if exists {stage};\n"
        f"create table {stage} (like public.dictionary_entries including all);\n"
        f"revoke all on table {stage} from public, anon, authenticated;\n"
        "commit;\n",
        encoding="utf-8",
    )

    paths = [create_path]
    for index, statement in enumerate(insert_statements(stage, entries, batch_size), start=1):
        batch_path = deploy_dir / f"{index:03d}-insert.sql"
        batch_path.write_text(f"begin;\n{statement}\ncommit;\n", encoding="utf-8")
        paths.append(batch_path)

    finalize_path = deploy_dir / "999-finalize.sql"
    finalize_path.write_text("\n".join([
        "begin;",
        verification_block(stage, entries, expected_md5, "stage"),
        "truncate table public.dictionary_entries;",
        "insert into public.dictionary_entries (word, phonetic, translation, pos)\n"
        f"select word, phonetic, translation, pos from {stage} order by word;",
        verification_block("public.dictionary_entries", entries, expected_md5, "final"),
        f"drop table {stage};",
        "commit;",
        "",
    ]), encoding="utf-8")
    paths.append(finalize_path)
    return paths


def signal_distribution(entries: list[dict]) -> dict:
    tags = Counter()
    source_counts = Counter()
    for entry in entries:
        tags.update(entry["signals"]["tags"])
        source_counts[str(signal_source_count(entry["signals"]))] += 1
    return {
        "frq_positive": sum(item["signals"]["frq"] > 0 for item in entries),
        "bnc_positive": sum(item["signals"]["bnc"] > 0 for item in entries),
        "oxford": sum(item["signals"]["oxford"] for item in entries),
        "collins": sum(item["signals"]["collins"] for item in entries),
        "lemma_frequency_positive": sum(
            item["signals"]["lemma_frequency"] > 0 for item in entries
        ),
        "exam_tags": dict(sorted(tags.items())),
        "signal_source_count": dict(sorted(source_counts.items())),
    }


def verification_sample(entries: list[dict], form_lemmas: dict[str, set[str]]) -> list[dict]:
    ranked = sorted(entries, key=ranking_key)
    selected = []
    words = set()

    def take(category: str, count: int, predicate: Callable[[dict], bool]) -> None:
        for entry in ranked:
            if sum(item["category"] == category for item in selected) >= count:
                break
            if entry["word"] in words or not predicate(entry):
                continue
            selected.append({
                "category": category,
                **{field: entry[field] for field in CSV_FIELDS},
            })
            words.add(entry["word"])

    take("common", 10, lambda item: signal_source_count(item["signals"]) >= 3)
    take("ielts", 5, lambda item: "ielts" in item["signals"]["tags"])
    take("toefl", 5, lambda item: "toefl" in item["signals"]["tags"])
    take("gre", 5, lambda item: "gre" in item["signals"]["tags"])
    take("cet_or_kaoyan", 5, lambda item: bool(
        {"cet4", "cet6", "ky"} & item["signals"]["tags"]
    ))
    take("phonetic_null", 5, lambda item: not item["phonetic"].strip())
    take("hyphen", 3, lambda item: "-" in item["word"])
    take("apostrophe", 2, lambda item: "'" in item["word"])
    take("long_translation", 5, lambda item: len(
        item["translation"].encode("utf-8")
    ) >= LONG_TRANSLATION_BYTES)
    take("lemma_or_inflection", 5, lambda item: any(
        lemma != item["word"] for lemma in form_lemmas.get(item["word"], set())
    ))
    if len(selected) != 50:
        raise RuntimeError(f"Only {len(selected)} verification sample entries were available")
    return selected


def write_outputs(
    output_dir: Path,
    mode: str,
    selected: list[dict],
    form_lemmas: dict[str, set[str]],
    manifest: dict,
    source_stats: dict,
    seed_file: Path | None,
) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    prefix = "core-dictionary" if mode == "core" else "dictionary-poc"
    csv_path = output_dir / f"{prefix}.csv"
    report_path = output_dir / f"{prefix}-report.json"
    sql_path = output_dir / f"{prefix}-import.sql"

    with csv_path.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=CSV_FIELDS, lineterminator="\n")
        writer.writeheader()
        for entry in selected:
            writer.writerow({key: entry[key] for key in CSV_FIELDS})

    snapshot_md5 = content_md5(selected)
    sql = build_import_sql(mode, selected, snapshot_md5)
    sql_path.write_text(sql, encoding="utf-8")
    management_paths = (
        write_management_api_bundle(output_dir, selected, snapshot_md5)
        if mode == "core"
        else []
    )
    if seed_file:
        seed_file.parent.mkdir(parents=True, exist_ok=True)
        seed_file.write_text(sql, encoding="utf-8")

    rejected_counts = Counter(source_stats["rejected_counts"])
    cutoff_reason = "below_core_ranking_cutoff" if mode == "core" else "not_selected_for_poc"
    rejected_counts[cutoff_reason] += source_stats["signal_backed_candidate_count"] - len(selected)
    reason_counts = Counter(entry["selection_reason"] for entry in selected)
    phonetic_count = sum(bool(item["phonetic"].strip()) for item in selected)
    translation_count = sum(bool(item["translation"].strip()) for item in selected)
    raw_text_bytes = sum(sum(
        len(str(item[field] or "").encode("utf-8")) for field in CSV_FIELDS
    ) for item in selected)
    rule_version = CORE_RULE_VERSION if mode == "core" else POC_RULE_VERSION
    actual_source_count = source_stats["source_record_count"]
    if actual_source_count != manifest["ecdict"]["totalRecords"]:
        raise RuntimeError(
            f"Manifest has {manifest['ecdict']['totalRecords']} records, read {actual_source_count}"
        )

    report = {
        "mode": mode,
        "source_dictionary_version": manifest["dictionaryVersion"],
        "source_record_count": actual_source_count,
        "source_chunk_count": manifest["ecdict"]["chunkCount"],
        "rule_version": rule_version,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "included_count": len(selected),
        "signal_backed_candidate_count": source_stats["signal_backed_candidate_count"],
        "rejected_counts": dict(sorted(rejected_counts.items())),
        "selection_reasons": dict(sorted(reason_counts.items())),
        "signal_distribution": signal_distribution(selected),
        "canonical_collision_count": source_stats["canonical_collision_count"],
        "canonical_collision_entry_count": source_stats["canonical_collision_entry_count"],
        "phonetic_nonempty_count": phonetic_count,
        "phonetic_null_count": len(selected) - phonetic_count,
        "phonetic_coverage": phonetic_count / len(selected),
        "translation_nonempty_count": translation_count,
        "translation_coverage": translation_count / len(selected),
        "pos_null_count": sum(not item["pos"].strip() for item in selected),
        "apostrophe_or_hyphen_count": sum(
            bool(re.search(r"['-]", item["word"])) for item in selected
        ),
        "long_translation_count": sum(
            len(item["translation"].encode("utf-8")) >= LONG_TRANSLATION_BYTES
            for item in selected
        ),
        "lemma_headword_count": sum(
            item["signals"]["lemma_frequency"] > 0 for item in selected
        ),
        "surface_forms_with_distinct_lemma_count": sum(any(
            lemma != item["word"] for lemma in form_lemmas.get(item["word"], set())
        ) for item in selected),
        "estimated_raw_text_bytes": raw_text_bytes,
        "csv_size_bytes": csv_path.stat().st_size,
        "csv_sha256": hashlib.sha256(csv_path.read_bytes()).hexdigest(),
        "database_content_md5": snapshot_md5,
        "import_strategy": (
            "private staging batches followed by an atomic verified replace"
            if mode == "core"
            else "transactional upsert"
        ),
        "verification_sample": verification_sample(selected, form_lemmas) if mode == "core" else [],
        "outputs": {
            "csv": str(csv_path),
            "report": str(report_path),
            "sql": str(sql_path),
            "seed": str(seed_file) if seed_file else None,
            "management_api_sql_files": [str(path) for path in management_paths],
        },
    }
    if sum(rejected_counts.values()) + len(selected) != actual_source_count:
        raise RuntimeError("Rejected counts do not reconcile with the source record count")
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        choices=("poc", "core", "core-lemma-pack"),
        default="poc",
    )
    parser.add_argument("--limit", type=int)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--seed-file", type=Path)
    parser.add_argument(
        "--core-csv",
        type=Path,
        help=(
            "Path to an existing core-dictionary.csv produced by --mode core. "
            "Required when --mode core-lemma-pack."
        ),
    )
    parser.add_argument(
        "--lemma-file",
        type=Path,
        help="Lemma source file for --mode core-lemma-pack (defaults to repo lemma.en.txt).",
    )
    args = parser.parse_args()

    if args.mode == "core-lemma-pack":
        if args.output_dir is None:
            parser.error("--mode core-lemma-pack requires --output-dir")
        if args.core_csv is None:
            parser.error("--mode core-lemma-pack requires --core-csv")
        output_dir = args.output_dir
        core_csv = args.core_csv
        lemma_path = args.lemma_file or LEMMA_PATH
        pack_path, manifest_path, stats = build_core_lemma_pack(
            core_csv_path=core_csv,
            lemma_en_path=lemma_path,
            output_dir=output_dir,
        )
        summary = {
            "mode": "core-lemma-pack",
            "coreCsv": str(core_csv),
            "lemmaSource": str(lemma_path),
            "packPath": str(pack_path),
            "manifestPath": str(manifest_path),
            "stats": stats,
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return

    default_limit = CORE_DEFAULT_LIMIT if args.mode == "core" else POC_DEFAULT_LIMIT
    limit = args.limit if args.limit is not None else default_limit
    if args.mode == "poc" and not 300 <= limit <= 500:
        parser.error("PoC --limit must be between 300 and 500")
    if args.mode == "core" and not 50_000 <= limit <= 70_000:
        parser.error("Core --limit must be between 50,000 and 70,000")

    output_dir = args.output_dir or Path(tempfile.mkdtemp(
        prefix=f"lingoflow-dictionary-{args.mode}."
    ))
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    candidates, form_lemmas, source_stats = read_candidates()
    selected = (
        select_core_dataset(candidates, limit)
        if args.mode == "core"
        else select_poc_dataset(candidates, form_lemmas, limit)
    )
    if len(selected) != limit:
        raise RuntimeError(f"Only {len(selected)} eligible entries were available")
    report = write_outputs(
        output_dir,
        args.mode,
        selected,
        form_lemmas,
        manifest,
        source_stats,
        args.seed_file,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
