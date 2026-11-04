import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// server.json is what `mcp-publisher publish` sends to the MCP registry. The registry checks that its name is the
// package's `mcpName`, so the two files must not drift apart (OPS-22).
const read = (name: string) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const pkg = read('package.json');
const server = read('server.json');

describe('MCP registry listing', () => {
    it('names the same server in package.json and server.json', () => {
        expect(pkg.mcpName).toBe('io.github.hwipit/mcp-server');
        expect(server.name).toBe(pkg.mcpName);
    });

    it('points at the npm package this repo publishes', () => {
        const [entry] = server.packages;
        expect(server.packages).toHaveLength(1);
        expect(entry.registryType).toBe('npm');
        expect(entry.identifier).toBe(pkg.name);
        expect(entry.transport).toEqual({ type: 'stdio' });
    });

    it('keeps the version a placeholder until a person publishes it', () => {
        // The real version only exists once semantic-release has published to npm; whoever runs `mcp-publisher
        // publish` sets both to it. Until then the two must agree with each other.
        expect(server.packages[0].version).toBe(server.version);
    });

    it('fits the registry description limit', () => {
        expect(server.description.length).toBeLessThanOrEqual(100);
    });

    it('does not ask for the API key as a required value (a login file works too)', () => {
        const key = server.packages[0].environmentVariables.find((v: { name: string }) => v.name === 'HWIP_API_KEY');
        expect(key).toMatchObject({ isSecret: true, isRequired: false });
    });
});
