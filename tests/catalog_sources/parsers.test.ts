import { describe, expect, it } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import {
  githubOwner,
  isSafeEntryPath,
  normalizeCatalogJson,
  normalizeRepoPath,
  parseGitmodules,
  parsePinnedCatalog,
  repoNameFromUrl,
} from '../../src/catalog_sources/providers.js';

describe('parseGitmodules', () => {
  it('maps submodule sections to path/url/branch entries', () => {
    const text = `# umbrella catalog submodules
[submodule "brain-mcp"]
\tpath = servers/brain-mcp
\turl = https://github.com/example/brain-mcp.git
\tbranch = main

[submodule "vaultwarden-mcp"]
\tpath = servers/vaultwarden-mcp
\turl = git@github.com:example/vaultwarden-mcp.git

[submodule "quoted"]
\tpath = "./servers/quoted/"
\turl = "https://github.com/example/quoted.git"
`;
    const modules = parseGitmodules(text);

    expect(modules).toHaveLength(3);
    expect(modules[0]).toEqual({
      name: 'brain-mcp',
      path: 'servers/brain-mcp',
      url: 'https://github.com/example/brain-mcp.git',
      branch: 'main',
    });
    expect(modules[1]).toMatchObject({
      name: 'vaultwarden-mcp',
      url: 'git@github.com:example/vaultwarden-mcp.git',
      branch: null,
    });
    // Quoted values are unquoted and `./` / trailing `/` are normalized.
    expect(modules[2]).toMatchObject({ name: 'quoted', path: 'servers/quoted' });
  });

  it('ignores comments, malformed lines and sections without a url', () => {
    const text = `
; comment
[submodule "missing-url"]
\tpath = servers/missing-url

[core]
\tbare = true

[submodule "ok"]
\tpath = ok
\turl = https://github.com/example/ok.git
`;
    const modules = parseGitmodules(text);
    expect(modules.map((module) => module.name)).toEqual(['ok']);
  });

  it('returns an empty list for empty or non-string input', () => {
    expect(parseGitmodules('')).toEqual([]);
    expect(parseGitmodules('   \n\n')).toEqual([]);
  });
});

describe('parsePinnedCatalog', () => {
  it('normalizes mcp[] and bundles[] with documented fields', () => {
    const parsed = parsePinnedCatalog({
      mcp: [
        {
          name: 'brain-mcp',
          serverName: 'brain',
          path: 'servers/brain-mcp',
          entry: 'brain-mcp.js',
          tag: 'v1.1.0',
          description: 'Example brain server',
          installCommand: './scripts/wire.sh',
        },
      ],
      bundles: [{ name: 'dsh-runtime', path: 'bundles/dsh-runtime', tag: 'v9.0.0' }],
    });

    expect(parsed.mcp).toEqual([
      {
        name: 'brain-mcp',
        serverName: 'brain',
        path: 'servers/brain-mcp',
        entry: 'brain-mcp.js',
        ref: 'v1.1.0',
        description: 'Example brain server',
        installCommand: './scripts/wire.sh',
        repoUrl: null,
        enabled: true,
      },
    ]);
    expect(parsed.bundles).toEqual([
      {
        name: 'dsh-runtime',
        path: 'bundles/dsh-runtime',
        entry: null,
        ref: 'v9.0.0',
        description: null,
        repoUrl: null,
      },
    ]);
  });

  it('supports alias fields and a bare array of entries', () => {
    const parsed = parsePinnedCatalog([
      {
        id: 'alias-server',
        server_name: 'alias',
        subpath: 'sub',
        entry_file: 'cli.js',
        ref: 'main',
        repo_url: 'https://github.com/example/alias-server.git',
        install_command: 'npm run wire',
        enabled: false,
      },
      'string-entry',
    ]);

    expect(parsed.mcp[0]).toMatchObject({
      name: 'alias-server',
      serverName: 'alias',
      path: 'sub',
      entry: 'cli.js',
      ref: 'main',
      repoUrl: 'https://github.com/example/alias-server.git',
      installCommand: 'npm run wire',
      enabled: false,
    });
    expect(parsed.mcp[1]).toMatchObject({ name: 'string-entry', entry: null });
    expect(parsed.bundles).toEqual([]);
  });

  it('rejects non-object payloads and objects without mcp/bundles arrays', () => {
    expect(() => parsePinnedCatalog('not-json')).toThrowError(GatewayError);
    expect(() => parsePinnedCatalog({ servers: [] })).toThrowError(GatewayError);
    try {
      parsePinnedCatalog({ servers: [] });
    } catch (error) {
      expect((error as GatewayError).code).toBe(ErrorCodes.INVALID_PARAMS);
    }
  });
});

describe('normalizeCatalogJson', () => {
  it('normalizes a bare array with documented fields', () => {
    const entries = normalizeCatalogJson(
      [
        {
          id: 'brain-mcp',
          name: 'brain-mcp',
          repoUrl: 'https://github.com/example/brain-mcp',
          tag: 'v1.1.0',
          entry: 'brain-mcp.js',
          serverName: 'brain',
          description: 'Example',
          installCommand: './wire.sh',
        },
      ],
      'cat_test',
    );

    expect(entries).toEqual([
      {
        id: 'brain-mcp',
        sourceId: 'cat_test',
        name: 'brain-mcp',
        repoUrl: 'https://github.com/example/brain-mcp',
        ref: 'v1.1.0',
        entry: 'brain-mcp.js',
        kind: 'mcp',
        serverName: 'brain',
        description: 'Example',
        installCommand: './wire.sh',
        supported: true,
        unsupportedReason: null,
        installedServerId: null,
      },
    ]);
  });

  it('accepts {entries:[...]} and normalizes aliases, bundles and flags', () => {
    const entries = normalizeCatalogJson(
      {
        entries: [
          {
            id: 'cli-server',
            repo_url: 'https://github.com/example/cli-server',
            ref: 'v2.0.0',
            server_name: 'cli',
            install_command: 'make wire',
            kind: 'bundle',
            supported: false,
            unsupported_reason: 'Requires the DSH runtime',
          },
          { name: 'no-repo' },
        ],
      },
      'cat_json',
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: 'cli-server',
      name: 'cli-server',
      repoUrl: 'https://github.com/example/cli-server',
      ref: 'v2.0.0',
      kind: 'bundle',
      serverName: 'cli',
      installCommand: 'make wire',
      supported: false,
      unsupportedReason: 'Requires the DSH runtime',
    });
    // An entry without a repoUrl cannot be installed.
    expect(entries[1]).toMatchObject({
      name: 'no-repo',
      repoUrl: '',
      supported: false,
      unsupportedReason: 'Catalog entry does not define a repository URL',
    });
  });

  it('deduplicates ids and skips nameless entries', () => {
    const entries = normalizeCatalogJson(
      [
        { name: 'dup', repoUrl: 'https://github.com/example/dup' },
        { name: 'dup', repoUrl: 'https://github.com/example/dup-2' },
        { repoUrl: 'https://github.com/example/no-name' },
      ],
      'cat_json',
    );
    expect(entries.map((entry) => entry.id)).toEqual(['dup', 'dup-2']);
  });

  it('rejects payloads that are not an array or {entries}', () => {
    expect(() => normalizeCatalogJson({ nope: true }, 'cat_json')).toThrowError(GatewayError);
    expect(() => normalizeCatalogJson('[]', 'cat_json')).toThrowError(GatewayError);
  });
});

describe('provider helpers', () => {
  it('extracts GitHub owners from https/ssh URLs', () => {
    expect(githubOwner('https://github.com/example/private-catalog.git')).toBe('example');
    expect(githubOwner('git@github.com:example/private-catalog.git')).toBe('example');
    expect(githubOwner('ssh://git@github.com/example/private-catalog.git')).toBe('example');
    expect(githubOwner('file:///tmp/catalog')).toBeNull();
  });

  it('derives entry names from repository URLs', () => {
    expect(repoNameFromUrl('https://github.com/example/brain-mcp.git')).toBe('brain-mcp');
    expect(repoNameFromUrl('https://github.com/example/brain-mcp/')).toBe('brain-mcp');
    expect(repoNameFromUrl('file:///tmp/example/brain-mcp')).toBe('brain-mcp');
  });

  it('normalizes and validates repository-relative paths', () => {
    expect(normalizeRepoPath('./servers//brain-mcp/')).toBe('servers/brain-mcp');
    expect(isSafeEntryPath('dist/index.js')).toBe(true);
    expect(isSafeEntryPath('../escape.js')).toBe(false);
    expect(isSafeEntryPath('/absolute.js')).toBe(false);
    expect(isSafeEntryPath('')).toBe(false);
  });
});
