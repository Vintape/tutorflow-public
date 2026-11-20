#!/usr/bin/env python3
"""Expose already installed plugin skills without changing Codex profiles."""

import json
import os
from pathlib import Path
import re
import tempfile


COMPONENTS = ('build-web-apps', 'superpowers', 'codex-security', 'context7', 'openai-developers')


def default_cache_dirs(root):
    """Read existing local and normal-profile caches; never create a profile."""
    caches = [root / '.data/codex-home/plugins/cache']
    if os.environ.get('CODEX_HOME'):
        caches.append(Path(os.environ['CODEX_HOME']).expanduser() / 'plugins/cache')
    caches.append(Path.home() / '.codex/plugins/cache')
    return list(dict.fromkeys(caches))


def find_installation(name, cache_dirs):
    """Choose the newest complete, matching release across installed marketplaces."""
    releases = []
    for cache in cache_dirs:
        for versions in sorted(cache.glob(f'*/{name}')):
            if not versions.is_dir():
                continue
            try:
                for release in versions.iterdir():
                    if release.is_dir() and re.fullmatch(r'\d+(?:\.\d+)*', release.name):
                        releases.append((tuple(map(int, release.name.split('.'))), release))
            except OSError:
                continue

    for _, release in sorted(releases, key=lambda candidate: candidate[0], reverse=True):
        try:
            manifest = json.loads((release / '.codex-plugin/plugin.json').read_text(encoding='utf-8'))
            if (not isinstance(manifest, dict) or manifest.get('name') != name
                    or manifest.get('version') != release.name):
                raise ValueError('manifest mismatch')
            skills = sorted(skill.parent for skill in (release / 'skills').glob('*/SKILL.md')
                            if skill.is_file())
            if not skills:
                raise ValueError('no complete skills')
        except (OSError, ValueError, UnicodeError):
            print(f'{name}: ignored incomplete or malformed release {release.name}')
            continue
        return release, skills
    return None


def ensure_directory(path, *, private=False):
    if path.is_symlink():
        raise ValueError(f'Refusing to use symlink directory: {path}')
    path.mkdir(mode=0o700 if private else 0o755, exist_ok=True)
    if private:
        path.chmod(0o700)


def write_inventory(data, linked):
    """Replace inventory atomically, without following an existing file symlink."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=data,
                                         prefix='.linked-codex-skills-', delete=False) as output:
            temporary = Path(output.name)
            json.dump(linked, output, indent=2)
            output.write('\n')
        temporary.replace(data / 'linked-codex-skills.json')
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def link_skills(root, cache_dirs=None):
    """Link cached skills in one checkout; explicit caches keep tests isolated."""
    root = Path(root).resolve()
    caches = default_cache_dirs(root) if cache_dirs is None else [Path(path) for path in cache_dirs]
    data = root / '.data'
    destination = root / '.agents/skills'
    ensure_directory(data, private=True)
    ensure_directory(root / '.agents')
    ensure_directory(destination)

    planned = []
    skipped = 0
    for name in COMPONENTS:
        installation = find_installation(name, caches)
        if installation is None:
            print(f'{name}: no valid cached installation; skipped')
            skipped += 1
            continue
        release, skills = installation
        for skill in skills:
            target = destination / f'vendor-{name}-{skill.name}'
            if target.exists() and not target.is_symlink():
                raise ValueError(f'Refusing to replace existing file or directory: {target}')
            planned.append((target, os.path.relpath(skill, destination)))
        print(f'{name}: {release.name}')

    linked = []
    for target, relative in planned:
        if target.is_symlink():
            if os.readlink(target) == relative:
                linked.append(target.name)
                continue
            target.unlink()
        target.symlink_to(relative, target_is_directory=True)
        linked.append(target.name)

    write_inventory(data, linked)
    print(f'{len(linked)} vendor skill links ready; {skipped} components skipped; '
          'normal Codex authentication is retained')
    return linked


if __name__ == '__main__':
    try:
        link_skills(Path(__file__).resolve().parents[1])
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from error
