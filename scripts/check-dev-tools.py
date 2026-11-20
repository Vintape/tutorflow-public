#!/usr/bin/env python3
"""Check tool discovery; --mcp requires real initialization and documentation calls."""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--mcp', action='store_true')
args = parser.parse_args()
results = {}
for name in ['node', 'npm', 'codex', 'git']:
    binary = shutil.which(name)
    if not binary:
        results[name] = {'status': 'missing'}
        continue
    try:
        process = subprocess.run([binary, '--version'], capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        results[name] = {'status': 'blocked', 'reason': 'version check timed out'}
        continue
    results[name] = {'status': 'ok' if process.returncode == 0 else 'failed',
                     'version': process.stdout.strip(), 'path': binary}
try:
    process = subprocess.run(['sh', str(root / 'scripts/playwright-tutorflow.sh'), '--version'],
                             capture_output=True, text=True, timeout=20)
    results['playwright-cli'] = {'status': 'ok' if process.returncode == 0 else 'failed',
                                 'version': process.stdout.strip()}
except subprocess.TimeoutExpired:
    results['playwright-cli'] = {'status': 'blocked', 'reason': 'version check timed out'}
results['project_skills'] = [p.parent.name for p in (root / '.agents/skills').glob('tutorflow-*/SKILL.md')]


def probe(name, url):
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
    if name == 'context7' and os.environ.get('CONTEXT7_API_KEY'):
        headers['Authorization'] = 'Bearer ' + os.environ['CONTEXT7_API_KEY']

    def rpc(method, params, identifier):
        payload = json.dumps({'jsonrpc': '2.0', 'id': identifier, 'method': method, 'params': params})
        request = urllib.request.Request(url, data=payload.encode(), headers=headers, method='POST')
        with urllib.request.urlopen(request, timeout=15) as response:
            session = response.headers.get('Mcp-Session-Id')
            if session:
                headers['Mcp-Session-Id'] = session
            text = response.read(1_000_000).decode()
        if text.lstrip().startswith('{'):
            message = json.loads(text)
        else:
            messages = [json.loads(line[5:].strip()) for line in text.splitlines()
                        if line.startswith('data:') and line[5:].strip()]
            message = next(m for m in messages if m.get('id') == identifier)
        if 'error' in message:
            raise RuntimeError('MCP protocol error')
        return message['result']

    rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {},
                      'clientInfo': {'name': 'tutorflow-doctor', 'version': '1.0.0'}}, 1)
    headers['MCP-Protocol-Version'] = '2025-03-26'
    notification = urllib.request.Request(url, data=json.dumps({
        'jsonrpc': '2.0', 'method': 'notifications/initialized'}).encode(), headers=headers, method='POST')
    with urllib.request.urlopen(notification, timeout=15):
        pass
    names = [tool['name'] for tool in rpc('tools/list', {}, 2)['tools']]
    tool = 'resolve-library-id' if name == 'context7' else 'search_openai_docs'
    if tool not in names:
        raise RuntimeError('Expected documentation tool missing')
    arguments = ({'libraryName': 'react', 'query': 'React useState TypeScript'}
                 if name == 'context7' else {'query': 'Responses API Structured Outputs'})
    response = rpc('tools/call', {'name': tool, 'arguments': arguments}, 3)
    if response.get('isError'):
        raise RuntimeError('Documentation tool returned isError')
    if not response.get('content'):
        raise RuntimeError('Documentation tool returned no content')
    if name == 'context7':
        if 'query-docs' not in names:
            raise RuntimeError('Documentation retrieval tool missing')
        text = '\n'.join(c.get('text', '') for c in response['content'])
        match = re.search(r'Library ID:\s*(/[A-Za-z0-9_./@-]+)', text, re.IGNORECASE)
        if not match:
            raise RuntimeError('No library ID returned for React')
        response = rpc('tools/call', {'name': 'query-docs', 'arguments': {
            'libraryId': match.group(1), 'query': 'React useState updater function TypeScript'}}, 4)
        if response.get('isError') or not response.get('content'):
            raise RuntimeError('Documentation retrieval failed')
        tool = 'resolve-library-id + query-docs'
    return {'status': 'ok', 'tool': tool, 'tools': names}


if args.mcp:
    for name, url in [('context7', 'https://mcp.context7.com/mcp'),
                      ('openaiDeveloperDocs', 'https://developers.openai.com/mcp')]:
        try:
            results[name] = probe(name, url)
        except urllib.error.HTTPError as error:
            results[name] = {'status': 'blocked', 'reason': f'HTTP {error.code}'}
        except (OSError, RuntimeError, ValueError, KeyError, StopIteration) as error:
            # Never print response bodies, environment values or authorization headers.
            reason = 'DNS/network unavailable' if isinstance(error, urllib.error.URLError) else type(error).__name__
            results[name] = {'status': 'blocked', 'reason': reason}
print(json.dumps(results, indent=2, ensure_ascii=False))
sys.exit(1 if any(isinstance(v, dict) and v.get('status') in ['failed', 'missing', 'blocked']
                  for v in results.values()) else 0)
