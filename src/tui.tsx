/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui";

/**
 * TUI companion for opencode-effect-harness.
 *
 * V2 shape (matches azatakmyradov/opencode-plugins conventions):
 * server entry `src/index.ts` + TUI entry `src/tui.tsx`, each a
 * `Plugin.define`, built to `dist/index.js` + `dist/tui.js`.
 * The server entrypoint automatically enables this matching TUI entrypoint.
 */
export default Plugin.define({
  id: "opencode.effect-harness",
  setup(context) {
    function AppExtensions() {
      context.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: "harness.toggle",
            title: "Toggle Harness",
            group: "Harness",
            description: "Enable/disable the effect gate for this project (see harness_toggle tool for persistence).",
            palette: true,
            run: () => {
              context.ui.toast.show({
                title: "Harness",
                message: "Use harness_toggle tool to persist mode per-project.",
                variant: "info",
              });
            },
          },
          {
            id: "harness.verify",
            title: "Verify",
            group: "Harness",
            description: "Run deterministic checks + pattern scan (effect_harness_verify).",
            palette: true,
            run: () => {
              context.ui.toast.show({
                title: "Harness",
                message: "Run effect_harness_verify, or see .effect-harness/reports/ for the last report.",
                variant: "info",
              });
            },
          },
          {
            id: "harness.benchmark",
            title: "Benchmark",
            group: "Harness",
            description: "Benchmark store: .effect-harness/benchmark.sqlite (effect_harness_compound).",
            palette: true,
            run: () => {
              context.ui.toast.show({
                title: "Harness",
                message: "Benchmark store: .effect-harness/benchmark.sqlite — use effect_harness_compound.",
                variant: "info",
              });
            },
          },
        ],
      }));
      return <></>;
    }

    const removeApp = context.ui.slot({ append: "app", render: AppExtensions });
    const removeStatus = context.ui.slot({
      append: "prompt.footer.status",
      render: () => <text>● harness active</text>,
    });

    return () => {
      removeStatus();
      removeApp();
    };
  },
});
