/**
 * Build-publishable — bundles the workspace kits into the plugin package
 * so it can be published as a single npm artifact.
 *
 * Heritage: opencode-effect-harness build pipeline
 *
 * Run with: bun run packages/effect-harness/scripts/build.ts
 */
import { $ } from 'bun';

const root = new URL('../..', import.meta.url).pathname;
const pkgRoot = new URL('.', import.meta.url).pathname.replace('/scripts/', '/');

console.log('Building opencode-effect-harness publishable package...\n');

// Step 1: typecheck everything
console.log('1. Typechecking...');
const tsc = await $`bunx tsc --noEmit`.cwd(root).quiet().nothrow();
if (tsc.exitCode !== 0) {
	console.error(tsc.stderr.toString());
	process.exit(1);
}
console.log('   ✓ clean\n');

// Step 2: run tests
console.log('2. Running tests...');
const test = await $`bunx vitest run --reporter=dot`.cwd(root).quiet().nothrow();
if (test.exitCode !== 0) {
	console.error(test.stdout.toString());
	process.exit(1);
}
console.log('   ✓ all passing\n');

// Step 3: rewrite the plugin's package.json for publishing
// - replace workspace:* deps with actual versions
// - add files list
const pkgPath = `${pkgRoot}/package.json`;
const pkg = await Bun.file(pkgPath).json();

const harnessKitPkg = await Bun.file(`${root}/packages/harness-kit/package.json`).json();
const verifyKitPkg = await Bun.file(`${root}/packages/verify-kit/package.json`).json();
const compoundKitPkg = await Bun.file(`${root}/packages/compound-kit/package.json`).json();

const versioned = { ...pkg };
if (versioned.dependencies['opencode-harness-kit'] === 'workspace:*') {
	versioned.dependencies['opencode-harness-kit'] = harnessKitPkg.version;
}
if (versioned.dependencies['opencode-verify-kit'] === 'workspace:*') {
	versioned.dependencies['opencode-verify-kit'] = verifyKitPkg.version;
}
if (versioned.dependencies['opencode-compound-kit'] === 'workspace:*') {
	versioned.dependencies['opencode-compound-kit'] = compoundKitPkg.version;
}

await Bun.write(pkgPath, JSON.stringify(versioned, null, '\t') + '\n');
console.log('3. Rewrote package.json with resolved versions\n');

// Step 4: dry-run pack
console.log('4. Packing...');
const pack = await $`bun pm pack --dry-run`.cwd(pkgRoot).quiet().nothrow();
if (pack.exitCode !== 0) {
	console.error(pack.stderr.toString());
	process.exit(1);
}
console.log(pack.stdout.toString());

// Restore workspace deps
await Bun.write(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');

console.log('\n✓ Publishable build verified. Run `cd packages/effect-harness && npm publish` to release.\n');
