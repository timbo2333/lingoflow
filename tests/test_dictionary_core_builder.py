import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts" / "build-dictionary-poc.py"
EXPECTED_CORE_SHA256 = "e15991ce6e9213ebdf73f7c494587866d5129fc217c81dd40d43c57e73632415"


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


if __name__ == "__main__":
    unittest.main()
