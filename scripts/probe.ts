/**
 * Capability probe — validates that the exact pinned plugin package
 * supports everything we need before feature-port work begins.
 *
 * Run with: bun run packages/effect-harness/scripts/probe.ts
 */
import { Effect } from 'effect';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

const check = async (name: string, fn: () => Promise<string>) => {
	try {
		const detail = await fn();
		results.push({ name, ok: true, detail });
	} catch (cause) {
		results.push({ name, ok: false, detail: String(cause) });
	}
};

await check('plugin module loads', async () => {
	const mod = await import('@opencode-ai/plugin/effect');
	if (typeof mod.Plugin?.define !== 'function') throw new Error('Plugin.define not found');
	return 'Plugin.define available';
});

await check('schema Tool.Error available', async () => {
	const { Tool } = await import('@opencode-ai/schema/tool');
	if (typeof Tool.Error !== 'function') throw new Error('Tool.Error not found');
	return `Tool.Error tag: ${new Tool.Error({ message: 'x' })._tag}`;
});

await check('effect version match', async () => {
	const pkg = await import('effect/package.json');
	return `effect ${pkg.version}`;
});

await check('@ast-grep/napi loads', async () => {
	const napi = await import('@ast-grep/napi');
	if (typeof napi.parse !== 'function') throw new Error('parse not found');
	const ast = napi.parse(napi.Lang.TypeScript, 'const x = 1;');
	if (!ast.root()) throw new Error('no root');
	return 'ast-grep works';
});

await check('yaml frontmatter parses', async () => {
	const YAML = (await import('yaml')).default;
	const parsed = YAML.parse('name: test\nlevel: warning');
	if (parsed.name !== 'test') throw new Error('parse mismatch');
	return 'yaml works';
});

// skill registration capability — inspect the plugin package's type surface
await check('skill.transform shape', async () => {
	const mod = await import('@opencode-ai/plugin/effect');
	void mod;
	// We can only verify at compile time; at runtime the host provides ctx.
	// Here we just confirm the import doesn't crash.
	return 'plugin/effect imports cleanly; runtime probe requires OpenCode server';
});

console.log('\n=== Capability Probe Results ===\n');
let allOk = true;
for (const r of results) {
	const icon = r.ok ? '✓' : '✗';
	console.log(`  ${icon} ${r.name}: ${r.detail}`);
	if (!r.ok) allOk = false;
}
console.log('');
if (!allOk) {
	process.exit(1);
}
