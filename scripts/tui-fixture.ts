import { appendFileSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

/** Test-only wrapper. It never changes the installed extension or user configuration. */
export default function (pi: ExtensionAPI) {
  const log = (event: string) =>
    appendFileSync(process.env.PI_TRANSLATE_TUI_EVENTS!, `${event}\n`);
  extension(
    new Proxy(pi, {
      get(target, key) {
        if (key !== "registerCommand") return Reflect.get(target, key);
        return (
          name: string,
          command: Parameters<ExtensionAPI["registerCommand"]>[1],
        ) =>
          pi.registerCommand(name, {
            ...command,
            handler: async (args, ctx) => {
              ctx.ui.setEditorText("TUI_DRAFT_NOT_SUBMITTED");
              const ui = new Proxy(ctx.ui, {
                get(targetUI, property) {
                  if (property !== "custom")
                    return Reflect.get(targetUI, property);
                  const custom: ExtensionContext["ui"]["custom"] = (
                    factory,
                    options,
                  ) =>
                    targetUI.custom((...params) => {
                      log("mount");
                      const pane = factory(...params);
                      if (pane instanceof Promise)
                        throw new Error("Expected synchronous pane factory");
                      const dispose = pane.dispose?.bind(pane);
                      let disposed = false;
                      pane.dispose = () => {
                        if (!disposed) {
                          disposed = true;
                          log("dispose");
                        }
                        dispose?.();
                      };
                      return pane;
                    }, options);
                  return custom;
                },
              });
              const wrapped = new Proxy(ctx, {
                get: (targetCtx, property) =>
                  property === "ui" ? ui : Reflect.get(targetCtx, property),
              });
              await command.handler(args, wrapped);
              log(
                ctx.ui.getEditorText() === "TUI_DRAFT_NOT_SUBMITTED"
                  ? "editor-restored"
                  : "editor-lost",
              );
            },
          });
      },
    }),
  );
  pi.on("before_agent_start", () => {
    log("UNEXPECTED_MODEL_REQUEST");
    throw new Error("UI probe must not submit a task");
  });
}
