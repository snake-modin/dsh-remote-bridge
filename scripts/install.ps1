# Install / reinstall the dsh-remote-bridge plugin into a DSH profile.
#
# What it does:
#   1. copies the package into $DSH_HOME/profiles/node_modules/dsh-remote-bridge
#   2. appends the plugin row to the profile's cordis.patch.yml (backed up first)
#
# Re-running is safe: an existing installation block is left untouched unless
# -Force is passed, in which case the old block is replaced.
#
# Usage:
#   pwsh -File install.ps1
#   pwsh -File install.ps1 -DshHome C:\Users\me\.dsh -ProfileName desktop -Force
[CmdletBinding()]
param(
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
    [string]$ProfileName = 'desktop',
    [string]$SourceDir = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($SourceDir)) { $SourceDir = Join-Path $PSScriptRoot '..' }
$source = (Resolve-Path $SourceDir).Path
$profileDir = Join-Path $DshHome (Join-Path 'profiles' $ProfileName)
$modulesDir = Join-Path $DshHome 'profiles\node_modules'
$target = Join-Path $modulesDir 'dsh-remote-bridge'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$marker = '# --- dsh-remote-bridge'

Write-Host "source     : $source"
Write-Host "dsh home   : $DshHome"
Write-Host "profile dir: $profileDir"

if (-not (Test-Path $patchPath)) { throw "profile patch not found: $patchPath" }

# 1. Copy the package into the profile module fallback directory.
New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
New-Item -ItemType Directory -Force -Path $target | Out-Null
foreach ($file in @('index.js', 'client.js', 'package.json', 'README.md')) {
    $from = Join-Path $source $file
    if (Test-Path $from) { Copy-Item -Force $from (Join-Path $target $file) }
}
Write-Host "installed package files -> $target"

# 2. Patch the profile.
$patch = [System.IO.File]::ReadAllText($patchPath)
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$hasBlock = $patch.Contains($marker)

if ($hasBlock -and -not $Force) {
    Write-Host 'profile patch already contains the dsh-remote-bridge block; package files refreshed, patch untouched'
    Write-Host '  (pass -Force to replace that block)'
} else {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item -Force $patchPath "$patchPath.bak-$stamp"
    Write-Host "backup     : $patchPath.bak-$stamp"
    if ($hasBlock) {
        $index = $patch.IndexOf($marker)
        $patch = $patch.Substring(0, $index).TrimEnd()
    }
    $fragment = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'cordis.patch.fragment.yml'))
    $separator = if ($patch.EndsWith("`n") -or $patch.Length -eq 0) { '' } else { "`n" }
    [System.IO.File]::WriteAllText($patchPath, $patch + $separator + $fragment, $utf8NoBom)
    Write-Host 'profile patch updated (host side applies through profile HMR or on the next start)'
}

Write-Host ''
Write-Host 'Next:'
Write-Host '  1. reload the DSH window (Ctrl+R) so the client plugin loads'
Write-Host '  2. click the 「远程」 entry at the bottom of the sidebar'
Write-Host '  3. if the entry never appears, fully restart DSH once'
