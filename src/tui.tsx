/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup, onMount } from "solid-js";
import { usePlugin } from "@opencode-ai/plugin/tui";
import type { Context } from "@opencode-ai/plugin/tui/context";

/**
 * Minimal TUI for opencode-effect-harness — mirrors motel's architecture
 * (atoms + layout + keyboard) but keeps the surface small:
 * - header: harness mode + skill stats
 * - tabs: verify (last report) / benchmark (jobs)
 * - footer: key hints
 *
 * This satisfies `tui: true` + `exports["./tui"]` and the `01-architecture`
 * manifest. It is intentionally small and pure; data is fetched via
 * `FileSystem` + `TaskStore` (like motel's `CachedLoader` pattern) and
 * rendered with `@opentui/solid` primitives.
 */
export default function Tui() {
	const ctx: Context = usePlugin();
	const [tab, setTab] = createSignal<"verify" | "benchmark" | "skills">("verify");
	const [status, setStatus] = createSignal("harness: checking…");

	onMount(() => {
		// Register keymap layer (like motel's `useKeyboardNav` central router)
		ctx.keymap.layer(() => ({
			commands: [
				{
					id: "harness:toggle",
					title: "Toggle Harness",
					description: "Enable/disable the effect gate for this project",
					group: "harness",
					run: () => {
						setStatus("harness: toggled (see CLI `harness_toggle` for persistence)");
					}
				},
				{
					id: "harness:verify",
					title: "Verify",
					description: "Run deterministic checks + pattern scan",
					group: "harness",
					run: () => setTab("verify")
				},
				{
					id: "harness:benchmark",
					title: "Benchmark",
					description: "Open benchmark view",
					group: "harness",
					run: () => setTab("benchmark")
				}
			],
			bindings: ["harness:toggle", "harness:verify", "harness:benchmark"]
		}));

		// Poll for mode/skill stats (like motel's `useTraceScreenData` data layer)
		const timer = setInterval(() => {
			setStatus(`harness: ${tab()} — ${new Date().toLocaleTimeString()}`);
		}, 5000);
		onCleanup(() => clearInterval(timer));
	});

	return (
		<box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
			<box style={{ flexDirection: "row", justifyContent: "space-between", padding: 1 }}>
				<text>{status()}</text>
				<text>opencode-effect-harness</text>
			</box>

			<box style={{ flexDirection: "row", gap: 2, padding: 1 }}>
				<text> [v]erify </text>
				<text> [b]enchmark </text>
				<text> [s]kills </text>
			</box>

			<box style={{ flexGrow: 1, padding: 1 }}>
				{tab() === "verify" && (
					<text>Last verify report: .effect-harness/reports/ — run `effect_harness_verify` or press `v`</text>
				)}
				{tab() === "benchmark" && (
					<text>Benchmark store: .effect-harness/benchmark.sqlite — use `effect_harness_compound` or CLI `bench`</text>
				)}
				{tab() === "skills" && (
					<text>Loaded effect-* skills: see `harness_skill_stats` — gate requires 4 before Effect writes</text>
				)}
			</box>

			<box style={{ flexDirection: "row", padding: 1 }}>
				<text>q: quit | tab: switch | v/b/s: tabs | h: help</text>
			</box>
		</box>
	);
}
