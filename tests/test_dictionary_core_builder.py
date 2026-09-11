import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts" / "build-dictionary-poc.py"
EXPECTED_CORE_SHA256 = "e15991ce6e9213ebdf73f7c494587866d5129fc217c81dd40d43c57e73632415"
EXPECTED_LEMMA_SHA256 = "e255b097404e3e0052060e2ddf6e15a1414f577071d63d51d2ca0ce9dacee0fc"
EXPECTED_PACK_SHA256 = "4d32fee17e33289a7529abe6dfee02557c417d033fa36703ee1e06cb8620bb39"


def load_builder():
    spec = importlib.util.spec_from_file_location("dictionary_core_builder", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DictionaryCoreBuilderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.builder = load_builder()
        cls.candidates, cls.form_lemmas, cls.source_stats = cls.builder.read_candidates()
        cls.selected = cls.builder.select_core_dataset(
            cls.candidates,
            cls.builder.CORE_DEFAULT_LIMIT,
        )
        cls.output = tempfile.TemporaryDirectory(prefix="lingoflow-core-builder-test.")
        manifest = json.loads(cls.builder.MANIFEST_PATH.read_text(encoding="utf-8"))
        cls.report = cls.builder.write_outputs(
            Path(cls.output.name),
            "core",
            cls.selected,
            cls.form_lemmas,
            manifest,
            cls.source_stats,
            None,
        )

    @classmethod
    def tearDownClass(cls):
        cls.output.cleanup()

    def test_core_snapshot_is_deterministic(self):
        candidates, _form_lemmas, source_stats = self.builder.read_candidates()
        selected = self.builder.select_core_dataset(candidates, 60_000)

        self.assertEqual(
            [entry["word"] for entry in selected],
            [entry["word"] for entry in self.selected],
        )
        self.assertEqual(
            self.builder.content_md5(selected),
            self.builder.content_md5(self.selected),
        )
        csv_path = Path(self.report["outputs"]["csv"])
        self.assertEqual(hashlib.sha256(csv_path.read_bytes()).hexdigest(), EXPECTED_CORE_SHA256)
        self.assertEqual(self.report["csv_sha256"], EXPECTED_CORE_SHA256)
        self.assertEqual(source_stats["source_record_count"], 770_611)

    def test_core_count_filters_collisions_and_preserves_nullable_fields(self):
        words = [entry["word"] for entry in self.selected]
        self.assertEqual(len(words), 60_000)
        self.assertEqual(len(set(words)), 60_000)
        self.assertTrue(set(words).isdisjoint(self.source_stats["collision_keys"]))
        self.assertTrue(all(self.builder.VALID_HEADWORD.fullmatch(word) for word in words))
        self.assertTrue(all(entry["translation"].strip() for entry in self.selected))
        self.assertTrue(all(self.builder.signal_source_count(entry["signals"]) > 0 for entry in self.selected))
        self.assertEqual(self.report["canonical_collision_count"], 1_832)
        self.assertEqual(self.report["phonetic_null_count"], 11_582)
        self.assertEqual(self.report["translation_nonempty_count"], 60_000)
        self.assertEqual(self.report["pos_null_count"], 60_000)

    def test_core_import_is_transactional_staging_replace(self):
        sql = Path(self.report["outputs"]["sql"]).read_text(encoding="utf-8")
        stage_verify = sql.index("$verify_stage$")
        truncate = sql.index("truncate table public.dictionary_entries;")
        final_insert = sql.index("insert into public.dictionary_entries", truncate)
        final_verify = sql.index("$verify_final$")

        self.assertTrue(sql.startswith("begin;\n"))
        self.assertTrue(sql.endswith("commit;\n"))
        self.assertLess(stage_verify, truncate)
        self.assertLess(truncate, final_insert)
        self.assertLess(final_insert, final_verify)
        self.assertIn(self.report["database_content_md5"], sql)
        self.assertIn("dictionary duplicate-word verification failed", sql)
        self.assertIn('order by word collate "C"', sql)

        management_paths = [
            Path(path) for path in self.report["outputs"]["management_api_sql_files"]
        ]
        self.assertEqual(len(management_paths), 17)
        self.assertTrue(all(path.stat().st_size < 1_000_000 for path in management_paths))
        self.assertIn(
            "revoke all on table public.dictionary_entries_stage_",
            management_paths[0].read_text(encoding="utf-8"),
        )
        finalize = management_paths[-1].read_text(encoding="utf-8")
        self.assertIn("truncate table public.dictionary_entries;", finalize)
        self.assertIn("$verify_stage$", finalize)
        self.assertIn("$verify_final$", finalize)

    def test_core_lemma_pack_rebuilds_without_a_checked_in_core_csv(self):
        output = Path(self.output.name) / "rebuilt-lemma-pack"
        rebuilt_pack, rebuilt_manifest, _stats = self.builder.build_core_lemma_pack(
            Path(self.report["outputs"]["csv"]),
            self.builder.LEMMA_PATH,
            output,
        )
        committed_pack = REPO / "data" / "dictionary" / "core-lemma-candidates.json"
        committed_manifest = REPO / "data" / "dictionary" / "core-lemma-manifest.json"

        self.assertEqual(rebuilt_pack.read_bytes(), committed_pack.read_bytes())
        self.assertEqual(rebuilt_manifest.read_bytes(), committed_manifest.read_bytes())


class CoreLemmaPackBuilderTests(unittest.TestCase):
    def setUp(self):
        self.builder = load_builder()
        self.temp = tempfile.TemporaryDirectory(prefix="lingoflow-lemma-pack-test.")
        self.root = Path(self.temp.name)
        self.core_csv = self.root / "core.csv"
        self.core_csv.write_text(
            "word,phonetic,translation,pos\n"
            "felt,,felt,\n"
            "go,,go,\n"
            "leaf,,leaf,\n"
            "leave,,leave,\n"
            "walk,,walk,\n",
            encoding="utf-8",
        )
        self.lemma = self.root / "lemma.txt"
        self.lemma.write_text(
            "go/100 -> goes,went,goes\n"
            "leave/90 -> leaves\n"
            "leaf/10 -> leaves\n"
            "felt/4 -> felt\n"
            "felt/4 -> felt\n",
            encoding="utf-8",
        )

    def tearDown(self):
        self.temp.cleanup()

    def build(self, name, lemma_path=None):
        output = self.root / name
        pack, manifest, stats = self.builder.build_core_lemma_pack(
            self.core_csv,
            lemma_path or self.lemma,
            output,
        )
        return pack, manifest, stats

    def test_explicit_lemma_input_is_used_and_empty_input_stays_empty(self):
        alternate = self.root / "alternate-lemma.txt"
        alternate.write_text("walk/20 -> walked\n", encoding="utf-8")
        alternate_pack, _manifest, alternate_stats = self.build("alternate", alternate)
        alternate_data = json.loads(alternate_pack.read_text(encoding="utf-8"))
        self.assertEqual(set(alternate_data), {"walk", "walked"})
        self.assertEqual(alternate_stats["entry_count"], 2)

        empty = self.root / "empty-lemma.txt"
        empty.write_text("; no lemma records\n", encoding="utf-8")
        empty_pack, _manifest, empty_stats = self.build("empty", empty)
        self.assertEqual(json.loads(empty_pack.read_text(encoding="utf-8")), {})
        self.assertEqual(empty_stats["entry_count"], 0)
        self.assertEqual(empty_stats["candidate_pair_count"], 0)

    def test_outputs_are_byte_deterministic(self):
        first_pack, first_manifest, _stats = self.build("first")
        second_pack, second_manifest, _stats = self.build("second")
        self.assertEqual(first_pack.read_bytes(), second_pack.read_bytes())
        self.assertEqual(first_manifest.read_bytes(), second_manifest.read_bytes())

    def test_duplicate_pairs_are_deduped_and_ambiguity_is_preserved(self):
        pack, _manifest, stats = self.build("dedupe")
        data = json.loads(pack.read_text(encoding="utf-8"))
        self.assertEqual(data["goes"], [["go", 100]])
        self.assertEqual(data["felt"], [["felt", 4]])
        self.assertEqual(data["leaves"], [["leave", 90], ["leaf", 10]])
        self.assertEqual(stats["entry_count"], 7)
        self.assertEqual(stats["candidate_pair_count"], 8)
        self.assertEqual(stats["ambiguous_form_count"], 1)

    def test_manifest_counts_and_pack_sha_match_artifact(self):
        pack, manifest_path, stats = self.build("manifest")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        pack_sha = hashlib.sha256(pack.read_bytes()).hexdigest()
        lemma_sha = hashlib.sha256(self.lemma.read_bytes()).hexdigest()
        self.assertEqual(manifest["packSha256"], pack_sha)
        self.assertEqual(manifest["lemmaSourceSha256"], lemma_sha)
        self.assertEqual(manifest["lemmaPackVersion"], "core-lemma-pack-v1")
        self.assertEqual(manifest["entryCount"], stats["entry_count"])
        self.assertEqual(manifest["candidatePairCount"], stats["candidate_pair_count"])
        self.assertEqual(manifest["ambiguousFormCount"], stats["ambiguous_form_count"])
        self.assertNotIn("generatedAt", manifest)

    def test_committed_pack_is_bound_to_locked_sources_and_counts(self):
        pack_path = REPO / "data" / "dictionary" / "core-lemma-candidates.json"
        manifest_path = REPO / "data" / "dictionary" / "core-lemma-manifest.json"
        lemma_path = REPO / "data" / "dictionary" / "lemma.en.txt"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        self.assertEqual(hashlib.sha256(pack_path.read_bytes()).hexdigest(), EXPECTED_PACK_SHA256)
        self.assertEqual(hashlib.sha256(lemma_path.read_bytes()).hexdigest(), EXPECTED_LEMMA_SHA256)
        self.assertEqual(manifest["packSha256"], EXPECTED_PACK_SHA256)
        self.assertEqual(manifest["lemmaSourceSha256"], EXPECTED_LEMMA_SHA256)
        self.assertEqual(manifest["coreSnapshotSha256"], EXPECTED_CORE_SHA256)
        self.assertEqual(manifest["entryCount"], 86_993)
        self.assertEqual(manifest["candidatePairCount"], 89_112)
        self.assertEqual(manifest["ambiguousFormCount"], 2_101)


if __name__ == "__main__":
    unittest.main()
