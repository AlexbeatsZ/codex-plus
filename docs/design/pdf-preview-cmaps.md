# PDF preview CMap loading

## Cause and scope

ChatGPT/Codex desktop `26.1007.30912` on macOS uses PDF.js for its shared PDF
preview. Its `document-4fcb6bc1faef.js` loader calls
`getDocument({data, worker})` without CMap resources. Embedded Fandol CID fonts
using Adobe-GB1 need `Adobe-GB1-UCS2`; PDF.js discards those fonts when that
resource cannot load. The same PDF renders correctly in macOS and in LaTeX
Workshop, whose PDF.js viewer configures `cMapUrl` and `cMapPacked`.

Fix the preview resource loader. Do not change LaTeX sources, PDF bytes, fonts,
the user's VS Code recipes, or the signed official application bundle.

## Runtime integration

`assets/pdf-preview.js` wraps the native Worker constructor, preserving its
prototype and arguments. Before PDF.js adds its message handler, the wrapper
registers a listener for its CMap resource callbacks. Current PDF.js uses
`FetchBinaryData` with `type=cMapReaderFactory`; older versions use
`FetchBuiltInCMap`. Only matching PDF document channels, valid callback IDs, and
packaged resource names are handled. The listener returns compressed local CMap
bytes using PDF.js's existing success callback protocol and stops the original
unconfigured factory from rejecting the same request. Other worker messages pass
through. No PDF content is transmitted outside the process.

The 168 resources and their license come from `pdfjs-dist` 5.6.205. Regenerate with
`node scripts/bundle-pdf-cmaps.mjs <pdfjs-dist/cmaps>`. They are embedded in the
launcher and decoded only on demand. The health object reports resource count,
loaded maps, and served requests; it stores no document content.

CDP installs the loader in every native main and detached window, immediately and
before scripts on later navigations. A separate session watches its liveness;
account/model injection is unchanged. All PDF sessions are cancelled with the
managed Codex lifecycle. Re-injection reuses the loader and replaces its preload
registration. Existing PDF workers require the preview to be reopened/refreshed.

## Verification

- `node --test tests/pdf-preview.test.mjs` validates real packaged bytes, current
  and legacy callback formats, worker passthrough, and idempotent restoration.
- Rust target filtering excludes avatars, embedded webviews, and remote sites.
- Live acceptance must use the installed application's own PDF.js and Worker,
  with its original `getDocument({data,worker})` parameters. Render and extract
  Chinese text from an unchanged PDF and check the resource-loader counters.
- Verify the normal PDF preview and LaTeX editor preview separately; a renderer
  unit test or successful TeX compile does not prove UI acceptance.

This is a local codex-plus repair of the official preview's resource-loading
path. An official upstream fix remains independent. Future PDF.js message
protocol changes require revalidation; unknown messages intentionally pass
through rather than being rewritten speculatively.

## Local deployment, 2026-10-13

`bash macos/release.sh` published the signed Mac base binary. Only the previous
launcher was terminated, followed by `--attach-existing`; the official app kept
PID 94550. The main and detached window loaders both report `ready=true` and
168 resources. With that deployed loader, the installed PDF.js renderer
successfully extracted Chinese from all six pages of an unchanged local PDF
(435 characters on page one) and rendered its first page correctly. One
`Adobe-GB1-UCS2` resource was loaded and served. The built-in LaTeX compiler also
returned success for the current source.

57 Rust tests and 25 JavaScript tests pass. Normal preview visual acceptance is
pending the user closing/reopening the previously cached preview: the computer
control tool denies operating Codex's own UI. Do not describe the user's visible
preview as accepted until they confirm it.

## Rejected approaches

- Extra ToUnicode data or replacement fonts in one document do not repair other
  PDFs and must not be presented as fixing the previewer.
- Patching `app.asar` breaks its signature/integrity seal.
- In Chromium 155, CDP `Debugger.setScriptSource` is unavailable and CDP Fetch
  interception does not capture the application's custom `app://` resources.
  Do not base hot patching on either interface in this application version.
