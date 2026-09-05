# dsh-codex-mode - local / offline deployment script.
#
# Preferred install is `dsh plugin --profile web add …/dsh-codex-mode`.
# That mounts `codex-preset-publisher`, which copies the preset on host boot.
# This script is the offline fallback: it copies the same real directory
# (scanRoot skips junctions) and keeps the plugins/ junction for local edits.
#
#   $DSH_HOME/plugins              -> <repo>/plugins                (implementation)
#   $DSH_HOME/.agent-presets/codex    real copy of <repo>/agent-presets/codex
#   <repo>/plugins/node_modules    -> $DSH_HOME/profiles/node_modules (dev deps)
#
# The preset rows reference `../../plugins/...`, which resolves to
# $DSH_HOME/plugins/... through the plugin junction above.
#
# Re-run this script after editing agent-presets/codex (composition, metadata,
# or check-rows). Plugin JS under plugins/ does not need a reinstall.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1 [-DshHome <path>]
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Uninstall
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

function Remove-ReparsePoint([string]$Link) {
    if (-not (Test-Path $Link)) { return }
    # PowerShell Remove-Item on a Directory Junction can throw a
    # NullReferenceException; cmd rmdir only unlinks the reparse point.
    cmd.exe /c "rmdir `"$Link`"" | Out-Null
    if (Test-Path $Link) {
        throw "Failed to remove reparse point: $Link"
    }
    Write-Host "  removed reparse point: $Link"
}

function Remove-Junction([string]$Link) {
    if (Test-Path $Link) {
        Remove-ReparsePoint $Link
    }
}

function Assert-RealDirectory([string]$Path) {
    $item = Get-Item $Path -Force
    if ($item.LinkType) {
        throw "Expected a real directory at $Path, still a $($item.LinkType)"
    }
    if (-not $item.PSIsContainer) {
        throw "Expected a directory at $Path"
    }
}

if ($Uninstall) {
    Write-Host "Removing dsh-codex-mode junctions and preset copy..."
    $presetCopy = Join-Path $DshHome '.agent-presets\codex'
    if (Test-Path $presetCopy) {
        $item = Get-Item $presetCopy -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            Remove-ReparsePoint $presetCopy
        } else {
            Remove-Item $presetCopy -Recurse -Force
            Write-Host "  removed preset copy: $presetCopy"
        }
    }
    Remove-Junction (Join-Path $DshHome 'plugins')
    Remove-Junction (Join-Path $Repo 'plugins\node_modules')
    Write-Host "Done. Profile patch rows (llm-openai / llm-responses) are untouched; remove them manually if desired."
    exit 0
}

if (-not (Test-Path $DshHome)) { throw "DSH home not found: $DshHome" }

Write-Host "Installing dsh-codex-mode into $DshHome (repo: $Repo)"
New-Junction (Join-Path $DshHome 'plugins') (Join-Path $Repo 'plugins')
Write-Host "  publishing preset via plugins/preset-publisher.js"
$env:DSH_HOME = $DshHome
& node (Join-Path $Repo 'plugins\preset-publisher.js')
if ($LASTEXITCODE -ne 0) { throw "preset publisher failed" }
Assert-RealDirectory (Join-Path $DshHome '.agent-presets\codex')

$profilesNodeModules = Join-Path $DshHome 'profiles\node_modules'
if (Test-Path $profilesNodeModules) {
    New-Junction (Join-Path $Repo 'plugins\node_modules') $profilesNodeModules
} else {
    Write-Host "  (skip dev-dep junction: $profilesNodeModules not found; smoke tests need it)"
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. LLM rows: install the bundle (dsh plugin --profile web add github:<owner>/dsh-codex-mode)"
Write-Host "     or keep manual rows in the profile cordis.patch.yml pointing at $($DshHome)\plugins\llm-openai.js"
Write-Host "  2. Restart dsh, then create a session with the 'codex' agent preset."
Write-Host "  3. Tests: cd $Repo ; node agent-presets/codex/check-rows.mjs (then smoke/alignment under plugins/)"
Write-Host "  4. Re-run this script after editing agent-presets/codex; plugin JS under plugins/ does not need a recopy."
