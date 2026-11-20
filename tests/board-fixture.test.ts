import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BoardRuntime } from '../server/boards/runtime.js';

it('reads a frozen v1 document without losing editable subject data across reopen', async () => {
  const fixture = JSON.parse(await readFile('tests/fixtures/board-v1.json', 'utf8'));
  const dir = await mkdtemp(join(tmpdir(), 'tutorflow-v1-fixture-'));
  let runtime = await BoardRuntime.open(dir, { lockRetries: 0 });
  try {
    const id = randomUUID();
    runtime.ensure(id, fixture);
    await runtime.close();
    runtime = await BoardRuntime.open(dir, { lockRetries: 0 });
    const states = runtime.snapshot(id).document.documents.map((entry) => entry.state);
    const ordered = (records: { id: string }[]) =>
      [...records].sort((a, b) => a.id.localeCompare(b.id));
    expect(ordered(states)).toEqual(
      ordered(fixture.document.documents.map((entry: { state: { id: string } }) => entry.state)),
    );
    expect(states.find((state) => state.id === 'shape:fixture-code-python')).toMatchObject({
      props: { source: 'print("Сохранённый пример")\n', version: 2 },
    });
    expect(() => runtime.ensure(randomUUID(), { ...fixture, schemaVersion: 2 })).toThrow();
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
