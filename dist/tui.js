// @bun
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = import.meta.require;

// src/tui.tsx
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Plugin } from "@opencode-ai/plugin/tui";
var tui_default = Plugin.define({
  id: "opencode.effect-harness",
  setup(context) {
    function AppExtensions() {
      context.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [{
          id: "harness.toggle",
          title: "Toggle Harness",
          group: "Harness",
          description: "Enable/disable the effect gate for this project (see harness_toggle tool for persistence).",
          palette: true,
          run: () => {
            context.ui.toast.show({
              title: "Harness",
              message: "Use harness_toggle tool to persist mode per-project.",
              variant: "info"
            });
          }
        }, {
          id: "harness.verify",
          title: "Verify",
          group: "Harness",
          description: "Run deterministic checks + pattern scan (effect_harness_verify).",
          palette: true,
          run: () => {
            context.ui.toast.show({
              title: "Harness",
              message: "Run effect_harness_verify, or see .effect-harness/reports/ for the last report.",
              variant: "info"
            });
          }
        }, {
          id: "harness.benchmark",
          title: "Benchmark",
          group: "Harness",
          description: "Benchmark store: .effect-harness/benchmark.sqlite (effect_harness_compound).",
          palette: true,
          run: () => {
            context.ui.toast.show({
              title: "Harness",
              message: "Benchmark store: .effect-harness/benchmark.sqlite \u2014 use effect_harness_compound.",
              variant: "info"
            });
          }
        }]
      }));
      return [];
    }
    const removeApp = context.ui.slot({
      append: "app",
      render: AppExtensions
    });
    const removeStatus = context.ui.slot({
      append: "prompt.footer.status",
      render: () => (() => {
        var _el$ = _$createElement("text");
        _$insertNode(_el$, _$createTextNode(`\u25CF harness active`));
        return _el$;
      })()
    });
    return () => {
      removeStatus();
      removeApp();
    };
  }
});
export {
  tui_default as default
};
