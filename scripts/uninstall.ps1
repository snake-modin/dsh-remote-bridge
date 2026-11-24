# Uninstall the dsh-remote-bridge plugin from a DSH profile.
#
# Removes the plugin row from the profile's cordis.patch.yml (backed up first)
# and deletes the installed package copy. By default the most recent
# cordis.patch.yml.bak-* backup is restored instead of editing in place; pass
# -StripBlock to remove only the appended block.
#
# Usage:
#   pwsh -File uninstall.ps1
#   pwsh -File uninstall.ps1 -KeepPackage -StripBlock
[CmdletBinding()]
param(
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
    [string]$ProfileName = 'desktop',
    [switch]$KeepPackage,
    [switch]$StripBlock
)

$ErrorActionPreference = 'Stop'
$profileDir = Join-Path $DshHome (Join-Path 'profiles' $ProfileName)
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$target = Join-Path $DshHome 'profiles\node_modules\dsh-remote-bridge'
$marker = '# --- dsh-remote-bridge'

if (-not (Test-Path $patchPath)) { throw "profile patch not found: $patchPath" }
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

$restored = $false
if (-not $StripBlock) {
    $latestBackup = Get-ChildItem $profileDir -Filter 'cordis.patch.yml.bak-*' -File |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestBackup) {
        Copy-Item -Force $latestBackup.FullName $patchPath
        Write-Host "restored patch from $($latestBackup.Name)"
        $restored = $true
    } else {
        Write-Host 'no backup found; stripping the appended block instead'
    }
}

if (-not $restored) {
    $patch = [System.IO.File]::ReadAllText($patchPath)
    $index = $patch.IndexOf($marker)
    if ($index -ge 0) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Copy-Item -Force $patchPath "$patchPath.bak-$stamp"
        [System.IO.File]::WriteAllText($patchPath, $patch.Substring(0, $index).TrimEnd(), $utf8NoBom)
        Write-Host "removed the dsh-remote-bridge block (backup: $patchPath.bak-$stamp)"
    } else {
        Write-Host 'no dsh-remote-bridge block present; patch unchanged'
    }
}

if (-not $KeepPackage -and (Test-Path $target)) {
    Remove-Item -Recurse -Force $target
    Write-Host "removed package copy: $target"
}

Write-Host 'Done. Restart DSH (or reload the page) to drop the sidebar entry.'
