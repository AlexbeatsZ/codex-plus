import { loadNative, type AXElement, type NativeModule, type WindowRecord } from "@zavora-ai/computer-use-mcp/host-native";

export type DesktopMouseAction = "move" | "click" | "double_click" | "right_click" | "drag" | "scroll";

let nativeModule: NativeModule | undefined;

function native(): NativeModule {
  nativeModule ??= loadNative();
  return nativeModule;
}

export class DesktopOperations {
  state() {
    const api = native();
    return {
      cursor: api.cursorPosition(),
      frontmostApp: api.getFrontmostApp(),
      displays: api.listDisplays(),
      windows: api.listWindows(),
    };
  }

  screenshot(width = 1440, windowId?: number) {
    return native().takeScreenshot(width, undefined, 82, undefined, windowId);
  }

  mouse(action: DesktopMouseAction, x?: number, y?: number, deltaY = 0, deltaX = 0) {
    const api = native();
    if (action === "scroll") {
      api.mouseScroll(deltaY, deltaX);
      return { action, cursor: api.cursorPosition() };
    }
    if (x === undefined || y === undefined) throw new Error(`${action} requires x and y`);
    if (action === "move") api.mouseMove(x, y);
    else if (action === "click") api.mouseClick(x, y, "left", 1);
    else if (action === "double_click") api.mouseClick(x, y, "left", 2);
    else if (action === "right_click") api.mouseClick(x, y, "right", 1);
    else if (action === "drag") api.mouseDrag(x, y);
    return { action, cursor: api.cursorPosition() };
  }

  keyboard(text?: string, key?: string, repeat = 1) {
    const api = native();
    if ((text === undefined) === (key === undefined)) throw new Error("Provide exactly one of text or key");
    if (text !== undefined) api.typeText(text);
    else api.keyPress(key!, repeat);
    return { typed: text !== undefined, key: key ?? null, repeat };
  }

  find(windowId: number, role?: string, label?: string, value?: string, maxResults = 20): AXElement[] {
    return native().findElement(windowId, role, label, value, maxResults);
  }

  uiAction(args: {
    windowId: number;
    operation: "activate_window" | "perform" | "set_value";
    role?: string;
    label?: string;
    action?: string;
    value?: string;
  }) {
    const api = native();
    if (args.operation === "activate_window") return api.activateWindow(args.windowId);
    if (!args.role || !args.label) throw new Error(`${args.operation} requires role and label`);
    if (args.operation === "perform") {
      if (!args.action) throw new Error("perform requires action");
      return api.performAction(args.windowId, args.role, args.label, args.action);
    }
    if (args.value === undefined) throw new Error("set_value requires value");
    return api.setElementValue(args.windowId, args.role, args.label, args.value);
  }
}

export type DesktopState = ReturnType<DesktopOperations["state"]>;
export type DesktopScreenshot = ReturnType<DesktopOperations["screenshot"]>;
export type DesktopWindow = WindowRecord;
