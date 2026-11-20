"""Regression checks for the local-only Codex skill linker."""

import json
from contextlib import redirect_stdout
import io
import os
from pathlib import Path
import runpy
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/link-codex-skills.py'


class CleanCheckoutTest(unittest.TestCase):
    def test_import_does_not_write_to_the_checkout(self):
        # Importing the injectable entry point must not run the CLI against a profile.
        with tempfile.TemporaryDirectory(prefix='tutorflow-link-test-') as temporary:
            root = Path(temporary)
            script = root / 'scripts/link-codex-skills.py'
            script.parent.mkdir()
            shutil.copyfile(SCRIPT, script)

            runpy.run_path(str(script))

            self.assertFalse((root / '.data').exists())
            self.assertFalse((root / '.agents').exists())

    def test_clean_checkout_creates_private_state_directory(self):
        # Losing the state-directory creation must reproduce the clean-clone crash.
        with tempfile.TemporaryDirectory(prefix='tutorflow-link-test-') as temporary:
            root = Path(temporary)
            script = root / 'scripts/link-codex-skills.py'
            script.parent.mkdir()
            shutil.copyfile(SCRIPT, script)

            result = subprocess.run(
                [sys.executable, str(script)],
                capture_output=True, text=True, check=False,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(stat.S_IMODE((root / '.data').stat().st_mode), 0o700)
            linked = json.loads((root / '.data/linked-codex-skills.json').read_text())
            self.assertIsInstance(linked, list)
            for name in linked:
                self.assertTrue((root / '.agents/skills' / name / 'SKILL.md').is_file())


class LinkSkillsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='tutorflow-link-test-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / 'checkout'
        self.root.mkdir()
        script = self.base / 'module/scripts/link-codex-skills.py'
        script.parent.mkdir(parents=True)
        shutil.copyfile(SCRIPT, script)
        with redirect_stdout(io.StringIO()):
            self.module = runpy.run_path(str(script))
        self.cache = self.base / 'profile/.codex/plugins/cache'

    def release(self, name='superpowers', version='7.0.1', *, cache=None,
                marketplace='openai-curated-remote', skill='debugging'):
        source = (cache or self.cache) / marketplace / name / version
        (source / '.codex-plugin').mkdir(parents=True)
        (source / '.codex-plugin/plugin.json').write_text(json.dumps({
            'name': name, 'version': version,
        }))
        (source / 'skills' / skill).mkdir(parents=True)
        (source / 'skills' / skill / 'SKILL.md').write_text('# Test skill\n')
        return source

    def link(self, cache_dirs=None):
        linker = self.module.get('link_skills')
        self.assertTrue(callable(linker), 'Expose an import-safe, injectable link_skills entry point')
        output = io.StringIO()
        with redirect_stdout(output):
            linked = linker(self.root, cache_dirs=[self.cache] if cache_dirs is None else cache_dirs)
        return linked, output.getvalue()

    def test_explicit_empty_caches_skip_every_component(self):
        linked, output = self.link(cache_dirs=[])
        self.assertEqual(linked, [])
        self.assertEqual(output.count('; skipped'), 5)
        self.assertEqual(json.loads((self.root / '.data/linked-codex-skills.json').read_text()), [])

    def test_discovers_existing_local_and_normal_profile_marketplaces(self):
        local = self.root / '.data/codex-home/plugins/cache'
        self.release('build-web-apps', '0.1.0', cache=local, marketplace='tutorflow-official-cache')
        latest = self.release('build-web-apps', '0.1.2', skill='frontend')
        context = self.release('context7', '1.0.2', marketplace='context7-marketplace', skill='docs')

        linked, output = self.link(cache_dirs=[local, self.cache])

        self.assertEqual(linked, ['vendor-build-web-apps-frontend', 'vendor-context7-docs'])
        self.assertEqual((self.root / '.agents/skills' / linked[0]).resolve(), latest / 'skills/frontend')
        self.assertEqual((self.root / '.agents/skills' / linked[1]).resolve(), context / 'skills/docs')
        self.assertEqual(output.count('; skipped'), 3)

    def test_chooses_numeric_latest_release(self):
        self.release(version='7.0.9')
        latest = self.release(version='7.0.10')

        linked, _ = self.link()

        self.assertEqual(linked, ['vendor-superpowers-debugging'])
        self.assertEqual((self.root / '.agents/skills' / linked[0]).resolve(), latest / 'skills/debugging')

    def test_malformed_newer_releases_fall_back_to_a_valid_installation(self):
        valid = self.release(version='7.0.1')
        invalid = {
            '7.0.2': '{',
            '7.0.3': '[]',
            '7.0.4': '{"name": "other", "version": "7.0.4"}',
            '7.0.5': '{"name": "superpowers"}',
            '7.0.6': '{"name": "superpowers", "version": "9.0.0"}',
        }
        for version, manifest in invalid.items():
            source = self.release(version=version)
            (source / '.codex-plugin/plugin.json').write_text(manifest)
        missing_manifest = self.release(version='7.0.7')
        (missing_manifest / '.codex-plugin/plugin.json').unlink()
        incomplete = self.release(version='7.0.8')
        (incomplete / 'skills/debugging/SKILL.md').unlink()
        self.release(version='not-a-version')

        linked, _ = self.link()

        self.assertEqual(linked, ['vendor-superpowers-debugging'])
        self.assertEqual((self.root / '.agents/skills' / linked[0]).resolve(), valid / 'skills/debugging')

    def test_only_malformed_installation_is_skipped(self):
        source = self.release()
        (source / '.codex-plugin/plugin.json').write_text('{')

        linked, output = self.link()

        self.assertEqual(linked, [])
        self.assertIn('superpowers:', output)
        self.assertEqual(output.count('; skipped'), 5)

    def test_refuses_to_replace_an_ordinary_directory_or_file(self):
        self.release()
        destination = self.root / '.agents/skills'
        destination.mkdir(parents=True, exist_ok=True)
        target = destination / 'vendor-superpowers-debugging'
        for kind in ('directory', 'file'):
            with self.subTest(kind=kind):
                if kind == 'directory':
                    target.mkdir()
                    sentinel = target / 'keep.txt'
                    sentinel.write_text('keep')
                else:
                    target.write_text('keep')
                    sentinel = target
                try:
                    with self.assertRaisesRegex((ValueError, SystemExit), 'Refusing to replace'):
                        self.link()
                    self.assertEqual(sentinel.read_text(), 'keep')
                finally:
                    sentinel.unlink()
                    if kind == 'directory':
                        target.rmdir()

    def test_repairs_a_broken_vendor_symlink(self):
        source = self.release()
        destination = self.root / '.agents/skills'
        destination.mkdir(parents=True, exist_ok=True)
        target = destination / 'vendor-superpowers-debugging'
        target.symlink_to('removed-cache', target_is_directory=True)

        linked, _ = self.link()

        self.assertEqual(linked, [target.name])
        self.assertEqual(target.resolve(), source / 'skills/debugging')
        self.assertFalse(Path(os.readlink(target)).is_absolute())

    def test_repeated_run_keeps_valid_links_and_profile_settings(self):
        self.release()
        profile_config = self.base / 'profile/.codex/config.toml'
        profile_config.write_text('# untouched profile\n')
        environment = {name: os.environ.get(name) for name in ('HOME', 'CODEX_HOME')}
        first, _ = self.link()
        target = self.root / '.agents/skills' / first[0]
        before = target.lstat()
        inventory = (self.root / '.data/linked-codex-skills.json').read_bytes()

        second, _ = self.link()

        self.assertEqual(second, first)
        self.assertEqual(target.lstat().st_ino, before.st_ino)
        self.assertEqual(target.lstat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual((self.root / '.data/linked-codex-skills.json').read_bytes(), inventory)
        self.assertEqual(profile_config.read_text(), '# untouched profile\n')
        self.assertEqual({name: os.environ.get(name) for name in environment}, environment)

    def test_existing_state_directory_is_private(self):
        data = self.root / '.data'
        data.mkdir(exist_ok=True)
        data.chmod(0o755)

        self.link(cache_dirs=[])

        self.assertEqual(stat.S_IMODE(data.stat().st_mode), 0o700)

    def test_refuses_symlinked_state_or_skill_parent_directories(self):
        external = self.base / 'external'
        external.mkdir()
        for relative in ('.data', '.agents', '.agents/skills'):
            with self.subTest(path=relative):
                root = self.base / relative.replace('/', '-')
                root.mkdir()
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(external, target_is_directory=True)
                linker = self.module.get('link_skills')
                self.assertTrue(callable(linker), 'Expose an injectable link_skills entry point')
                with self.assertRaisesRegex((ValueError, SystemExit), 'symlink'):
                    linker(root, cache_dirs=[])
                self.assertEqual(list(external.iterdir()), [])

    def test_inventory_symlink_does_not_overwrite_its_external_target(self):
        external = self.base / 'keep.json'
        external.write_text('keep')
        data = self.root / '.data'
        data.mkdir(exist_ok=True)
        inventory = data / 'linked-codex-skills.json'
        inventory.symlink_to(external)

        self.link(cache_dirs=[])

        self.assertEqual(external.read_text(), 'keep')
        self.assertFalse(inventory.is_symlink())
        self.assertEqual(json.loads(inventory.read_text()), [])


if __name__ == '__main__':
    unittest.main()
