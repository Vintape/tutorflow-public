#!/usr/bin/env python3
"""Private, bounded, offline Graphify AST navigator. See docs/GRAPHIFY_EVALUATION.md."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'graphify-out'
PYTHON = Path.home() / '.local/share/uv/tools/graphifyy/bin/python'
ROOTS = ('src', 'server', 'shared', 'tests')
DENY = {'.git', '.data', '.codex', 'node_modules', 'dist', 'coverage', 'test-results', 'playwright-report', 'fixtures', '__pycache__'}
SUFFIXES = {'.ts', '.tsx'}


def corpus(root=ROOT):
    files = []
    for name in ROOTS:
        base = root / name
        if base.is_symlink():
            raise ValueError(f'symlink root rejected: {name}')
        if not base.is_dir():
            continue
        for directory, dirs, names in os.walk(base, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in DENY and not d.startswith('.') and not (Path(directory) / d).is_symlink())
            for name in sorted(names):
                p = Path(directory) / name
                if name.startswith('.') or p.suffix not in SUFFIXES or p.is_symlink():
                    continue
                if not p.resolve().is_relative_to(root.resolve()):
                    raise ValueError(f'outside root: {p}')
                files.append(p)
    return sorted(files)


def digest(files, root=ROOT):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}


def child(snapshot, output):
    # Linux x86_64 seccomp: deny network syscalls in this process and descendants.
    # Fail closed if the filter cannot be installed. No environment or credentials inherited.
    import ctypes
    import platform
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise RuntimeError('offline filter requires Linux x86_64')
    class Filter(ctypes.Structure):
        _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint)]
    class Prog(ctypes.Structure):
        _fields_ = [('len', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]
    # Socket family: socket, connect, accept, sendto, recvfrom, sendmsg,
    # recvmsg, bind, listen, getsockname, getpeername, socketpair, accept4.
    calls = (41, 42, 43, 44, 45, 46, 47, 49, 50, 51, 52, 53, 288)
    rules = [Filter(0x20, 0, 0, 0)]
    for n in calls:
        rules += [Filter(0x15, 0, 1, n), Filter(0x06, 0, 0, 0x00050001)]
    rules += [Filter(0x06, 0, 0, 0x7fff0000)]
    arr = (Filter * len(rules))(*rules)
    prog = Prog(len(rules), arr)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) or libc.prctl(22, 2, ctypes.byref(prog)):
        raise OSError(ctypes.get_errno(), 'cannot install offline filter')
    import socket
    try:
        socket.socket()
    except PermissionError:
        pass
    else:
        raise RuntimeError('offline filter failed self-check')
    from graphify.extract import extract
    root = Path(snapshot)
    result = extract(corpus(root), root=root, cache_root=root, parallel=False)
    Path(output).write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')


def build():
    if not PYTHON.is_file():
        raise RuntimeError('Graphify interpreter missing; no automatic installation')
    OUT.mkdir(mode=0o700, exist_ok=True)
    if OUT.is_symlink() or not OUT.is_dir():
        raise ValueError('graphify-out must be a real directory')
    os.chmod(OUT, 0o700)
    files = corpus()
    before = digest(files)
    with tempfile.TemporaryDirectory(prefix='graphify-local-', dir=OUT) as temp:
        temp = Path(temp)
        snapshot = temp / 'snapshot'
        for p in files:
            dest = snapshot / p.relative_to(ROOT)
            dest.parent.mkdir(parents=True, exist_ok=True)
            # Reject swapped symlinks and detect any concurrent content change.
            fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as f:
                data = f.read()
            if hashlib.sha256(data).hexdigest() != before[str(p.relative_to(ROOT))]:
                raise RuntimeError('source changed during snapshot; retry')
            dest.write_bytes(data)
        if digest(corpus()) != before:
            raise RuntimeError('corpus changed during snapshot; retry')
        result = temp / 'result.json'
        subprocess.run([str(PYTHON), '-I', str(Path(__file__).resolve()), '_child', str(snapshot), str(result)],
                       env={'PATH': '/usr/bin:/bin', 'HOME': str(temp), 'TMPDIR': str(temp)},
                       cwd=temp, check=True, timeout=180)
        extraction = json.loads(result.read_text(encoding='utf-8'))
        if not extraction.get('nodes'):
            raise RuntimeError('empty extraction')
        if digest(corpus()) != before:
            raise RuntimeError('corpus changed during extraction; retry')
        # Graph and hashes are installed atomically together.
        output = temp / 'graph.json'
        output.write_text(json.dumps({'manifest': before, 'extraction': extraction}, ensure_ascii=False), encoding='utf-8')
        os.chmod(output, 0o600)
        os.replace(output, OUT / 'graph.json')
    print(f"Indexed {len(before)} files, {len(extraction['nodes'])} nodes, {len(extraction['edges'])} edges; offline AST only")


def query(terms):
    graph = json.loads((OUT / 'graph.json').read_text(encoding='utf-8'))
    if digest(corpus()) != graph['manifest']:
        raise RuntimeError('index stale: run build; source files changed, added or removed')
    data = graph['extraction']
    nodes = {n['id']: n for n in data['nodes']}
    terms = [t.casefold() for t in terms]
    found = [n for n in nodes.values() if all(t in (str(n.get('label', '')) + ' ' + str(n.get('source_file', ''))).casefold() for t in terms)]
    for n in found[:30]:
        print(json.dumps({'node': n, 'confidence': 'AST extracted; verify in source'}, ensure_ascii=False))
        count = 0
        for e in data['edges']:
            if e.get('source') == n['id'] or e.get('target') == n['id']:
                other = e.get('target') if e.get('source') == n['id'] else e.get('source')
                print('  ' + json.dumps({'edge': e, 'neighbor': nodes.get(other), 'confidence': 'static candidate; verify in source'}, ensure_ascii=False))
                count += 1
                if count == 12:
                    break
    print(f'Matches: {len(found)} (showing at most 30, 12 edges each). Static navigation is not proof of runtime behavior or authorization.')


if __name__ == '__main__':
    try:
        if len(sys.argv) == 4 and sys.argv[1] == '_child':
            child(sys.argv[2], sys.argv[3])
        else:
            parser = argparse.ArgumentParser()
            parser.add_argument('action', choices=['build', 'query'])
            parser.add_argument('terms', nargs='*')
            args = parser.parse_args()
            if args.action == 'build':
                build()
            elif args.terms:
                query(args.terms)
            else:
                parser.error('query requires search terms')
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'graphify-local: {error}', file=sys.stderr)
        sys.exit(1)
