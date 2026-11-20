import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('graphify_local', Path(__file__).resolve().parents[2] / 'scripts/graphify-local.py')
graph = importlib.util.module_from_spec(spec)
spec.loader.exec_module(graph)

class LocalGraphTest(unittest.TestCase):
    def test_allowlist_and_symlinks(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as outside:
            root = Path(d)
            (root / 'src').mkdir()
            (root / 'src/good.ts').write_text('export const a = 1')
            (root / 'src/.env.ts').write_text('secret')
            (root / 'src/node_modules').mkdir()
            (root / 'src/node_modules/no.ts').write_text('no')
            (root / 'src/fixtures').mkdir()
            (root / 'src/fixtures/no.ts').write_text('no')
            (Path(outside) / 'no.ts').write_text('outside')
            (root / 'src/link.ts').symlink_to(Path(outside) / 'no.ts')
            (root / 'src/linkdir').symlink_to(outside, target_is_directory=True)
            self.assertEqual([p.name for p in graph.corpus(root)], ['good.ts'])
            (root / 'server').symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError): graph.corpus(root)

    def test_manifest_catches_modification_and_untracked_addition(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'src').mkdir()
            p = root / 'src/a.ts'
            p.write_text('a')
            before = graph.digest(graph.corpus(root), root)
            p.write_text('b')
            self.assertNotEqual(before, graph.digest(graph.corpus(root), root))
            p.write_text('a')
            (root / 'src/new.ts').write_text('new')
            self.assertNotEqual(before, graph.digest(graph.corpus(root), root))

    def test_query_rejects_stale(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'src').mkdir()
            (root / 'src/a.ts').write_text('a')
            out = root / 'graphify-out'
            out.mkdir()
            (out / 'graph.json').write_text(json.dumps({'manifest': {}, 'extraction': {'nodes': [], 'edges': []}}))
            old_root, old_out = graph.ROOT, graph.OUT
            try:
                graph.ROOT, graph.OUT = root, out
                # default arguments are bound to original root; temporarily bind explicitly.
                original_corpus, original_digest = graph.corpus, graph.digest
                graph.corpus = lambda: original_corpus(root)
                graph.digest = lambda files: original_digest(files, root)
                with self.assertRaisesRegex(RuntimeError, 'stale'): graph.query(['a'])
            finally:
                graph.ROOT, graph.OUT = old_root, old_out
                graph.corpus, graph.digest = original_corpus, original_digest

if __name__ == '__main__': unittest.main()
