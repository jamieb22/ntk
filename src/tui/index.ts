/**
 * NeedToKnow TUI part (opencode-quota pattern): renders the diagnostics
 * commands natively — /ntk-status as a dialog, /ntk-debug as toasts (toggle)
 * and a dialog (status) — instead of a model prompt. Display only: nothing
 * shown here enters chat or model context (design.md §2). The NTK-017 file
 * sinks (.ntk/status.md + plugin log) are written here too, so the audit
 * trail matches the server part's headless path.
 */
import path from "node:path";
import { Plugin } from "@opencode/plugin/tui";
import {
  buildDebugReport,
  buildStatusSummary,
  pluginVersion,
} from "../core/status.js";
import { localReport } from "../core/debug-logging.js";
import { LOG_FILE, log } from "../core/log.js";

export default Plugin.define({
  id: "needtoknow",
  setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "needtoknow.status",
          title: "NeedToKnow status (index, retrieval, log)",
          group: "NeedToKnow",
          palette: true,
          slash: { name: "ntk-status" },
          run: async () => {
            const loc = context.location ?? context.data.location.default();
            const root = loc.directory;
            const { report } = buildStatusSummary({
              root,
              version: pluginVersion(),
              logFile: LOG_FILE,
            });
            // NTK-017 file sinks (the durable channel the server command
            // also writes; this TUI report is the compact core facts, the
            // full server view — cache stats, docs, preview — needs the
            // server process, so .ntk/status.md carries whichever ran last).
            localReport(root, report, (l) =>
              log(`[${path.basename(root)}] /ntk-status → ${l} (${report.length} chars)`),
            );
            context.ui.dialog.set({ size: "large", centered: true });
            await context.ui.dialog.alert({ title: "NeedToKnow — Status", message: report });
          },
        },
      ],
      bindings: ["needtoknow.status"],
    }));
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "needtoknow.debug",
          title: "NeedToKnow debug mode (on | off | status)",
          group: "NeedToKnow",
          palette: true,
          slash: { name: "ntk-debug", arguments: true },
          run: async (input) => {
            const loc = context.location ?? context.data.location.default();
            const root = loc.directory;
            const project = path.basename(root);
            const arg = (input ?? "").trim().toLowerCase();
            const report = buildDebugReport(root, arg, LOG_FILE, pluginVersion());
            // NTK-017 file sinks, shared builder with the server command.
            localReport(root, report, (l) =>
              log(`[${project}] /ntk-debug ${arg || "status"} → ${l} (${report.length} chars)`),
            );
            if (arg === "on" || arg === "off") {
              // Toggle is a transient event: confirm with a toast (notify/quota
              // pattern); the full help text lands in .ntk/status.md.
              context.ui.toast.show({
                title: "NeedToKnow",
                message: report.split("\n")[0]!,
                variant: "success",
                duration: 2500,
              });
              return;
            }
            context.ui.dialog.set({ size: "large", centered: true });
            await context.ui.dialog.alert({ title: "NeedToKnow — Debug", message: report });
          },
        },
      ],
      bindings: ["needtoknow.debug"],
    }));
  },
});
