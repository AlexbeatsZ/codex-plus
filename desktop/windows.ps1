$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$request = $env:CODEX_PLUS_DESKTOP_REQUEST | ConvertFrom-Json

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ("CodexPlusDesktopNative" -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CodexPlusDesktopNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public MOUSEINPUT mi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern uint SendInput(uint inputCount, INPUT[] inputs, int inputSize);

    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;

    public static void TypeUnicode(string text) {
        foreach (char ch in text) {
            var down = new INPUT {
                type = INPUT_KEYBOARD,
                U = new InputUnion {
                    ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = KEYEVENTF_UNICODE }
                }
            };
            var up = down;
            up.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            var inputs = new[] { down, up };
            if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) {
                throw new InvalidOperationException("SendInput failed while typing text");
            }
        }
    }

    public static void Key(ushort virtualKey, bool down) {
        var input = new INPUT {
            type = INPUT_KEYBOARD,
            U = new InputUnion {
                ki = new KEYBDINPUT {
                    wVk = virtualKey,
                    wScan = 0,
                    dwFlags = down ? 0u : KEYEVENTF_KEYUP
                }
            }
        };
        var inputs = new[] { input };
        if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) != 1) {
            throw new InvalidOperationException("SendInput failed while sending a key");
        }
    }
}
"@
}

[void][CodexPlusDesktopNative]::SetThreadDpiAwarenessContext([IntPtr](-4))

function Get-CursorPoint {
    $point = New-Object CodexPlusDesktopNative+POINT
    if (-not [CodexPlusDesktopNative]::GetCursorPos([ref]$point)) {
        throw "GetCursorPos failed"
    }
    [pscustomobject]@{ x = $point.X; y = $point.Y }
}

function Get-PrimaryScreen {
    $width = [CodexPlusDesktopNative]::GetSystemMetrics(0)
    $height = [CodexPlusDesktopNative]::GetSystemMetrics(1)
    [pscustomobject]@{
        left = 0
        top = 0
        width = $width
        height = $height
        right = $width
        bottom = $height
    }
}

function Get-VirtualScreen {
    $left = [CodexPlusDesktopNative]::GetSystemMetrics(76)
    $top = [CodexPlusDesktopNative]::GetSystemMetrics(77)
    $width = [CodexPlusDesktopNative]::GetSystemMetrics(78)
    $height = [CodexPlusDesktopNative]::GetSystemMetrics(79)
    [pscustomobject]@{
        left = $left
        top = $top
        width = $width
        height = $height
        right = $left + $width
        bottom = $top + $height
    }
}

function Get-DesktopWindows {
    $items = [System.Collections.Generic.List[object]]::new()
    $callback = [CodexPlusDesktopNative+EnumWindowsProc]{
        param([IntPtr]$handle, [IntPtr]$unused)
        if (-not [CodexPlusDesktopNative]::IsWindowVisible($handle)) { return $true }
        if ([CodexPlusDesktopNative]::IsIconic($handle)) { return $true }
        $length = [CodexPlusDesktopNative]::GetWindowTextLengthW($handle)
        if ($length -le 0) { return $true }
        $title = [System.Text.StringBuilder]::new($length + 1)
        [void][CodexPlusDesktopNative]::GetWindowTextW($handle, $title, $title.Capacity)
        $rect = New-Object CodexPlusDesktopNative+RECT
        if (-not [CodexPlusDesktopNative]::GetWindowRect($handle, [ref]$rect)) { return $true }
        $width = $rect.Right - $rect.Left
        $height = $rect.Bottom - $rect.Top
        if ($width -le 1 -or $height -le 1) { return $true }
        [uint32]$processId = 0
        [void][CodexPlusDesktopNative]::GetWindowThreadProcessId($handle, [ref]$processId)
        $processName = $null
        try { $processName = (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch {}
        $items.Add([pscustomobject]@{
            handle = $handle.ToInt64()
            processId = $processId
            process = $processName
            title = $title.ToString()
            rect = [pscustomobject]@{
                left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom
                width = $width; height = $height
            }
        })
        return $true
    }
    [void][CodexPlusDesktopNative]::EnumWindows($callback, [IntPtr]::Zero)
    $items
}

function Resolve-VirtualKey([string]$name) {
    $upper = $name.ToUpperInvariant()
    $map = @{
        "ENTER" = 0x0D; "RETURN" = 0x0D; "TAB" = 0x09; "ESC" = 0x1B; "ESCAPE" = 0x1B
        "BACKSPACE" = 0x08; "DELETE" = 0x2E; "SPACE" = 0x20
        "LEFT" = 0x25; "UP" = 0x26; "RIGHT" = 0x27; "DOWN" = 0x28
        "HOME" = 0x24; "END" = 0x23; "PAGEUP" = 0x21; "PAGEDOWN" = 0x22
        "CTRL" = 0x11; "CONTROL" = 0x11; "SHIFT" = 0x10; "ALT" = 0x12
        "WIN" = 0x5B; "WINDOWS" = 0x5B; "CMD" = 0x5B
    }
    if ($map.ContainsKey($upper)) { return [uint16]$map[$upper] }
    if ($upper.Length -eq 1) {
        $code = [int][char]$upper[0]
        if (($code -ge 0x30 -and $code -le 0x39) -or ($code -ge 0x41 -and $code -le 0x5A)) {
            return [uint16]$code
        }
    }
    throw "Unsupported key: $name"
}

function Send-KeyChord([string]$chord) {
    $parts = @($chord.Split('+') | Where-Object { $_.Length -gt 0 })
    if ($parts.Count -eq 0) { throw "key must not be empty" }
    $modifiers = @()
    if ($parts.Count -gt 1) {
        for ($i = 0; $i -lt $parts.Count - 1; $i++) {
            $vk = Resolve-VirtualKey $parts[$i]
            $modifiers += $vk
            [CodexPlusDesktopNative]::Key($vk, $true)
        }
    }
    $primary = Resolve-VirtualKey $parts[-1]
    [CodexPlusDesktopNative]::Key($primary, $true)
    [CodexPlusDesktopNative]::Key($primary, $false)
    [array]::Reverse($modifiers)
    foreach ($vk in $modifiers) { [CodexPlusDesktopNative]::Key($vk, $false) }
}

function Build-UiaCondition($request) {
    Add-Type -AssemblyName UIAutomationClient
    $conditions = [System.Collections.Generic.List[System.Windows.Automation.Condition]]::new()
    if ($request.name) {
        $conditions.Add([System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty, [string]$request.name))
    }
    if ($request.automationId) {
        $conditions.Add([System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$request.automationId))
    }
    if ($request.controlType) {
        $types = @{
            "Button" = [System.Windows.Automation.ControlType]::Button
            "CheckBox" = [System.Windows.Automation.ControlType]::CheckBox
            "ComboBox" = [System.Windows.Automation.ControlType]::ComboBox
            "Edit" = [System.Windows.Automation.ControlType]::Edit
            "Hyperlink" = [System.Windows.Automation.ControlType]::Hyperlink
            "List" = [System.Windows.Automation.ControlType]::List
            "ListItem" = [System.Windows.Automation.ControlType]::ListItem
            "Menu" = [System.Windows.Automation.ControlType]::Menu
            "MenuItem" = [System.Windows.Automation.ControlType]::MenuItem
            "Pane" = [System.Windows.Automation.ControlType]::Pane
            "RadioButton" = [System.Windows.Automation.ControlType]::RadioButton
            "Tab" = [System.Windows.Automation.ControlType]::Tab
            "TabItem" = [System.Windows.Automation.ControlType]::TabItem
            "Text" = [System.Windows.Automation.ControlType]::Text
            "Tree" = [System.Windows.Automation.ControlType]::Tree
            "TreeItem" = [System.Windows.Automation.ControlType]::TreeItem
            "Window" = [System.Windows.Automation.ControlType]::Window
        }
        $controlType = $types[[string]$request.controlType]
        if ($null -eq $controlType) { throw "Unsupported UIA controlType: $($request.controlType)" }
        $conditions.Add([System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType))
    }
    if ($conditions.Count -eq 0) { throw "uia operation requires name, automationId, or controlType" }
    if ($conditions.Count -eq 1) { return $conditions[0] }
    return [System.Windows.Automation.AndCondition]::new($conditions.ToArray())
}

function Get-UiaMatches($request) {
    Add-Type -AssemblyName UIAutomationClient
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    if ($request.windowHandle) {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$request.windowHandle)
    }
    $condition = Build-UiaCondition $request
    $matches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $limit = if ($request.limit) { [Math]::Min([int]$request.limit, 100) } else { 20 }
    $items = [System.Collections.Generic.List[object]]::new()
    for ($i = 0; $i -lt $matches.Count -and $i -lt $limit; $i++) {
        $element = $matches.Item($i)
        $current = $element.Current
        $bounds = $current.BoundingRectangle
        $items.Add([pscustomobject]@{
            name = $current.Name
            automationId = $current.AutomationId
            className = $current.ClassName
            controlType = $current.ControlType.ProgrammaticName
            processId = $current.ProcessId
            nativeWindowHandle = $current.NativeWindowHandle
            enabled = $current.IsEnabled
            bounds = [pscustomobject]@{
                x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height
            }
        })
    }
    [pscustomobject]@{ root = $root; condition = $condition; matches = $matches; items = $items }
}

$result = switch ([string]$request.operation) {
    "state" {
        [pscustomobject]@{ cursor = Get-CursorPoint; screen = Get-PrimaryScreen; virtualScreen = Get-VirtualScreen; windows = @(Get-DesktopWindows) }
        break
    }
    "windows" { [pscustomobject]@{ windows = @(Get-DesktopWindows) }; break }
    "screenshot" {
        $screen = if ([string]$request.scope -eq "virtual") { Get-VirtualScreen } else { Get-PrimaryScreen }
        $path = [string]$request.outputPath
        if (-not $path) { throw "screenshot requires outputPath" }
        $directory = Split-Path -Parent $path
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
        $bitmap = [System.Drawing.Bitmap]::new($screen.width, $screen.height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.CopyFromScreen($screen.left, $screen.top, 0, 0, [System.Drawing.Size]::new($screen.width, $screen.height), [System.Drawing.CopyPixelOperation]::SourceCopy)
            } finally { $graphics.Dispose() }
            $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally { $bitmap.Dispose() }
        [pscustomobject]@{ screen = $screen; path = $path }
        break
    }
    "mouse" {
        $action = [string]$request.action
        if ($null -ne $request.x -and $null -ne $request.y) {
            if (-not [CodexPlusDesktopNative]::SetCursorPos([int]$request.x, [int]$request.y)) { throw "SetCursorPos failed" }
        }
        switch ($action) {
            "move" {}
            "click" { [CodexPlusDesktopNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [CodexPlusDesktopNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
            "double_click" { 1..2 | ForEach-Object { [CodexPlusDesktopNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [CodexPlusDesktopNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) } }
            "right_click" { [CodexPlusDesktopNative]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero); [CodexPlusDesktopNative]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero) }
            "scroll" { [CodexPlusDesktopNative]::mouse_event(0x0800, 0, 0, [int]$request.deltaY, [UIntPtr]::Zero) }
            default { throw "Unsupported mouse action: $action" }
        }
        [pscustomobject]@{ action = $action; cursor = Get-CursorPoint }
        break
    }
    "keyboard" {
        if ($null -ne $request.text) {
            [CodexPlusDesktopNative]::TypeUnicode([string]$request.text)
            [pscustomobject]@{ typed = $true; length = ([string]$request.text).Length }
        } elseif ($request.key) {
            Send-KeyChord ([string]$request.key)
            [pscustomobject]@{ key = [string]$request.key }
        } else { throw "keyboard requires text or key" }
        break
    }
    "uia_find" {
        $found = Get-UiaMatches $request
        [pscustomobject]@{ elements = @($found.items) }
        break
    }
    "uia_action" {
        Add-Type -AssemblyName UIAutomationClient
        $found = Get-UiaMatches $request
        if ($found.matches.Count -eq 0) { throw "UIA element not found" }
        $element = $found.matches.Item(0)
        $action = [string]$request.action
        switch ($action) {
            "focus" { $element.SetFocus() }
            "invoke" {
                $pattern = $null
                if (-not $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { throw "UIA element does not support InvokePattern" }
                ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
            }
            "set_value" {
                $pattern = $null
                if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { throw "UIA element does not support ValuePattern" }
                ([System.Windows.Automation.ValuePattern]$pattern).SetValue([string]$request.value)
            }
            default { throw "Unsupported UIA action: $action" }
        }
        [pscustomobject]@{ action = $action; element = @($found.items)[0] }
        break
    }
    default { throw "Unsupported desktop operation: $($request.operation)" }
}

$result | ConvertTo-Json -Depth 10 -Compress
