[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$Root
)

$ErrorActionPreference = "Stop"

# tunnel-client needs the runtime key, but the MCP child does not.
[Environment]::SetEnvironmentVariable("CONTROL_PLANE_API_KEY", $null, "Process")
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", $null, "Process")

& (Join-Path $PSScriptRoot "start.ps1") -Root $Root -Stdio
exit $LASTEXITCODE
