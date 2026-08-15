# dsh-codex-mode — local deployment script (Windows, junctions, no code copy).
#
# Serves the repo's code from its original location through directory
# junctions, so edits in the repo take effect without re-copying:
#
#   $DSH_HOME/plugins            -> <repo>/plugins                (implementation)
#   $DSH_HOME/.agent-presets/codex -> <repo>/agent-presets/codex  (agent preset)
#   <repo>/plugins/node_modules  -> $DSH_HOME/profiles/node_modules (dev deps)
#
# The preset rows reference `../../plugins/...`, which resolves to
# $DSH_HOME/plugins/... through the junction pair above.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/install.ps1 [-DshHome <path>]
# Remove: powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Uninstall
param(
    [string]$DshHome = "$env:USERPROFILE\.dsh",
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function New-Junction([string]$Link, [string]$Target) {
    if (Test-Path $Link) {
        $item = Get-Item $Link -Force
        if ($item.LinkType -ne 'Junction') {
            throw "Refusing to replace non-junction path: $Link"
        }
        Write-Host "  junction already present: $Link"
        return
    }
    New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
    Write-Host "  junction: $Link -> $Target"
}

function Remove-Junction([string]$Link) {
    if (Test-Path $Link) {
        Remove-Item $Link -Force
        Write-Host "  removed junction: $Link"
    }
}

if ($Uninstall) {
    Write-Host "Removing dsh-codex-mode junctions…"
    Remove-Junction (Join-Path $DshHome '.agent-presets\codex')
    Remove-Junction (Join-Path $DshHome 'plugins')
    Remove-Junction (Join-Path $Repo 'plugins\node_modules')
    Write-Host "Done. The profile patch rows (llm-openai / llm-responses) are untouched — remove them manually if desired."
    exit 0
}

if (-not (Test-Path $DshHome)) { throw "DSH home not found: $DshHome" }

Write-Host "Installing dsh-codex-mode into $DshHome (repo: $Repo)"
New-Junction (Join-Path $DshHome 'plugins') (Join-Path $Repo 'plugins')
New-Junction (Join-Path $DshHome '.agent-presets\codex') (Join-Path $Repo 'agent-presets\codex')

$profilesNodeModules = Join-Path $DshHome 'profiles\node_modules'
if (Test-Path $profilesNodeModules) {
    New-Junction (Join-Path $Repo 'plugins\node_modules') $profilesNodeModules
} else {
    Write-Host "  (skip dev-dep junction: $profilesNodeModules not found — smoke tests need it)"
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. LLM rows: install the bundle (dsh plugin --profile web add github:<owner>/dsh-codex-mode)"
Write-Host "     or keep the manual rows in your profile cordis.patch.yml pointing at $($DshHome)\plugins\llm-openai.js"
Write-Host "  2. Restart dsh, then create a session with the 'codex' agent preset."
Write-Host "  3. Tests:  cd $Repo && node agent-presets/codex/check-rows.mjs  (then the smoke/alignment tests under plugins/)"
