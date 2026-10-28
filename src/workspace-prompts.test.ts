import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { create } from 'tar';

import {
  registerWorkspacePromptSync,
  syncWorkspacePrompts,
  upsertPromptFiles,
} from './workspace-prompts.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tlon-hosting-prompts-test-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    )
  );
});

describe('workspace prompt sync', () => {
  const managedBlock = (family: string, version: number, content: string) =>
    `<!-- idempotency-marker:${family}:v${version} -->\n${content}\n<!-- /idempotency-marker -->\n`;

  it.each(['complete', 'heartbeat-only', 'unmarked'])(
    'preserves all AGENTS.md block families across repeated refreshes (%s)',
    async (state) => {
      const root = await temporaryRoot();
      const sourceDir = join(root, 'source');
      const workspaceDir = join(root, 'workspace');
      await mkdir(sourceDir);
      await mkdir(workspaceDir);
      const blocks = [
        ['tlon-agents', 22, 'Agent instructions.'],
        ['tlon-tools', 33, 'Tool instructions.'],
        ['tlon-heartbeat-agents', 2, 'Heartbeat instructions.'],
        ['tlon-future-guidance', 1, 'Additional guidance.'],
      ] as const;
      const bundle = blocks
        .map(([family, version, content]) =>
          managedBlock(family, version, content)
        )
        .join('\n');
      const notes = '# Owner preferences\nKeep replies concise.\n';
      const unrelated = managedBlock(
        'operator-guidance',
        1,
        'Keep this independently managed instruction.'
      );
      // The entrypoint writes the complete bundle before the hosting service;
      // older hosting syncs leave only the last block behind.
      const initial =
        state === 'complete'
          ? bundle + unrelated + notes
          : state === 'heartbeat-only'
            ? managedBlock(
                'tlon-heartbeat-agents',
                2,
                'Heartbeat instructions.'
              ) +
              unrelated +
              notes
            : notes;
      await writeFile(join(sourceDir, 'AGENTS.md'), bundle);
      const destination = join(workspaceDir, 'AGENTS.md');
      await writeFile(destination, initial);
      const params = {
        sourceDir,
        workspaceDir,
        config: {} as never,
        logger: { info: vi.fn(), warn: vi.fn() },
      };

      await upsertPromptFiles(params);
      const first = await readFile(destination, 'utf8');
      for (const [family, version, content] of blocks) {
        expect(
          first.split(managedBlock(family, version, content))
        ).toHaveLength(2);
      }
      expect(first).toContain(notes);
      if (state !== 'unmarked') expect(first).toContain(unrelated);
      if (state === 'complete') expect(first).toBe(initial);
      await upsertPromptFiles(params);
      expect(await readFile(destination, 'utf8')).toBe(first);

      // A version change replaces only its family, including stale duplicates.
      await writeFile(
        destination,
        first + managedBlock('tlon-agents', 21, 'Stale duplicate.')
      );
      const updatedBundle = bundle.replace(
        managedBlock('tlon-agents', 22, 'Agent instructions.'),
        managedBlock('tlon-agents', 23, 'Updated agent instructions.')
      );
      await writeFile(join(sourceDir, 'AGENTS.md'), updatedBundle);
      await upsertPromptFiles(params);
      const updated = await readFile(destination, 'utf8');
      expect(updated).toBe(
        first.replace(
          managedBlock('tlon-agents', 22, 'Agent instructions.'),
          managedBlock('tlon-agents', 23, 'Updated agent instructions.')
        )
      );
    }
  );

  it('updates one AGENTS.md family in place ahead of long owner notes', async () => {
    const root = await temporaryRoot();
    const sourceDir = join(root, 'source');
    const workspaceDir = join(root, 'workspace');
    await mkdir(sourceDir);
    await mkdir(workspaceDir);
    const agents = managedBlock('tlon-agents', 22, 'Agent instructions.');
    const oldTools = managedBlock('tlon-tools', 32, 'Old tool instructions.');
    const tools = managedBlock('tlon-tools', 33, 'Updated tool instructions.');
    const heartbeat = managedBlock(
      'tlon-heartbeat-agents',
      2,
      'Heartbeat instructions.'
    );
    const notes = '# Owner notes\n' + 'Keep this owner preference.\n'.repeat(1600);
    const destination = join(workspaceDir, 'AGENTS.md');
    await writeFile(join(sourceDir, 'AGENTS.md'), tools);
    await writeFile(
      destination,
      agents +
        oldTools +
        heartbeat +
        notes +
        managedBlock('tlon-tools', 31, 'Stale duplicate.') +
        '<!-- idempotency-marker:tlon-tools:v30 -->\n'
    );
    const params = {
      sourceDir,
      workspaceDir,
      config: {} as never,
      logger: { info: vi.fn(), warn: vi.fn() },
    };

    await upsertPromptFiles(params);
    const expected = agents + tools + heartbeat + notes;
    expect(await readFile(destination, 'utf8')).toBe(expected);
    await upsertPromptFiles(params);
    expect(await readFile(destination, 'utf8')).toBe(expected);
  });

  it('replaces managed prompt blocks idempotently and preserves operator text', async () => {
    const root = await temporaryRoot();
    const sourceDir = join(root, 'source');
    const workspaceDir = join(root, 'workspace');
    await mkdir(sourceDir);
    await mkdir(workspaceDir);
    await writeFile(
      join(sourceDir, 'AGENTS.md'),
      `<!-- idempotency-marker:tlon-agents:v10 -->
Owner: \${TLON_OWNER_SHIP}
<!-- /idempotency-marker -->
`
    );
    await writeFile(
      join(sourceDir, 'BOOT.md'),
      `<!-- idempotency-marker:tlon-boot:v2 -->
Boot \${TLON_SHIP}
<!-- /idempotency-marker -->
`
    );
    await writeFile(
      join(workspaceDir, 'AGENTS.md'),
      `Custom operator note.
<!-- idempotency-marker:tlon-agents:v7 -->
Old managed instructions.
<!-- /idempotency-marker -->
`
    );
    await writeFile(
      join(workspaceDir, 'BOOT.md'),
      `Preserve this custom instruction.
<!-- idempotency-marker:operator-boot:v1 -->
Preserve this independently managed block.
<!-- /idempotency-marker -->
<!-- idempotency-marker:tlon-boot:v1 -->
Old boot instructions.
<!-- /idempotency-marker -->
`
    );
    vi.stubEnv('TLON_SHIP', 'sampel-palnet');
    vi.stubEnv('TLON_OWNER_SHIP', '~sampel-owner');
    vi.stubEnv('TLON_DISABLE_HEARTBEATS', 'true');

    const params = {
      sourceDir,
      workspaceDir,
      config: {} as never,
      logger: { info: vi.fn(), warn: vi.fn() },
    };
    await upsertPromptFiles(params);
    await upsertPromptFiles(params);

    const agents = await readFile(join(workspaceDir, 'AGENTS.md'), 'utf8');
    const boot = await readFile(join(workspaceDir, 'BOOT.md'), 'utf8');
    expect(agents).toContain('Custom operator note.');
    expect(agents).not.toContain('Old managed instructions.');
    expect(agents).toContain('Owner: ~sampel-owner');
    expect(agents.match(/idempotency-marker:tlon-agents:v10/g)).toHaveLength(1);
    expect(boot).toContain('Preserve this custom instruction.');
    expect(boot).toContain('idempotency-marker:operator-boot:v1');
    expect(boot).not.toContain('Old boot instructions.');
    expect(boot).toContain('Boot sampel-palnet');
    expect(boot.match(/idempotency-marker:tlon-boot:v2/g)).toHaveLength(1);
  });

  // Mirrors tlonbot's test_memory_prompt_refresh_preserves_* (78fb4cd): this
  // sync runs alone on OpenClaw's in-process restarts, so it has to keep
  // learned memory as tlawn's does.
  describe('MEMORY.md', () => {
    async function refreshMemory(previous: string): Promise<string> {
      const root = await temporaryRoot();
      const sourceDir = join(root, 'source');
      const workspaceDir = join(root, 'workspace');
      await mkdir(sourceDir);
      await mkdir(workspaceDir);
      await writeFile(
        join(sourceDir, 'MEMORY.md'),
        `<!-- idempotency-marker:tlon-runtime:v4 -->
Keep learned entries outside this managed block.
<!-- /idempotency-marker -->
`
      );
      await writeFile(join(workspaceDir, 'MEMORY.md'), previous);
      const params = {
        sourceDir,
        workspaceDir,
        config: {} as never,
        logger: { info: vi.fn(), warn: vi.fn() },
      };
      await upsertPromptFiles(params);
      const first = await readFile(join(workspaceDir, 'MEMORY.md'), 'utf8');
      await upsertPromptFiles(params);
      expect(await readFile(join(workspaceDir, 'MEMORY.md'), 'utf8')).toBe(first);
      expect(first.match(/idempotency-marker:tlon-runtime:v4/g)).toHaveLength(1);
      expect(first).toContain('Keep learned entries outside this managed block.');
      return first;
    }

    it('keeps learned entries and operator blocks', async () => {
      const memory = await refreshMemory(`# Learned preferences
Owner-approved shared preference: use concise project summaries.

<!-- idempotency-marker:tlon-runtime:v2 -->
Context recall is handled by LCM.
<!-- /idempotency-marker -->

<!-- idempotency-marker:operator-memory:v1 -->
Keep this independently managed note.
<!-- /idempotency-marker -->
`);
      expect(memory).toContain('use concise project summaries.');
      expect(memory).toContain('idempotency-marker:operator-memory:v1');
      expect(memory).toContain('Keep this independently managed note.');
      expect(memory).not.toContain('idempotency-marker:tlon-runtime:v2');
      expect(memory).not.toContain('Context recall is handled by LCM.');
    });

    it('keeps a file the bot rewrote without the marker', async () => {
      const memory = await refreshMemory(
        '# Learned preferences\nOwner-approved shared preference: use concise project summaries.\n'
      );
      expect(memory).toContain('use concise project summaries.');
    });
  });

  it('registers an awaited gateway service', () => {
    const registerService = vi.fn();

    registerWorkspacePromptSync({ registerService } as never);

    expect(registerService).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tlon-hosting-workspace-prompts',
        start: expect.any(Function),
      })
    );
  });

  it('downloads and extracts the hosted prompt archive', async () => {
    const root = await temporaryRoot();
    const payloadDir = join(root, 'payload');
    const workspaceDir = join(root, 'workspace');
    const archive = join(root, 'prompts.tar.gz');
    await mkdir(payloadDir);
    await mkdir(workspaceDir);
    await writeFile(join(payloadDir, 'SOUL.md'), 'Ship: ${TLON_SHIP}\n');
    await create({ cwd: payloadDir, file: archive, gzip: true }, ['SOUL.md']);
    const payload = await readFile(archive);
    vi.stubEnv('TLON_SHIP', 'sampel-palnet');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(payload, { status: 200 }))
    );

    await syncWorkspacePrompts({
      workspaceDir,
      config: {} as never,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(await readFile(join(workspaceDir, 'SOUL.md'), 'utf8')).toBe(
      'Ship: sampel-palnet\n'
    );
  });
});
