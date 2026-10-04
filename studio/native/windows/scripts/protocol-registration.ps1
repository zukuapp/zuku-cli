#Requires -Version 5.1
<#
.SYNOPSIS
  Registers or removes the per-user zuku: URL protocol for ZUKU Studio (HKCU only).
.DESCRIPTION
  PENDING ROOT REVIEW: the installer must not call this until the owner of the installer
  approves it. It never writes HKLM (machine-wide), needs no elevation, and refuses to replace
  a zuku: handler that points somewhere other than the given ZukuStudio.exe.

  The command line is exactly: "<ZukuStudio.exe>" "%1"
  Studio itself accepts only the exact token-free URI zuku://ai/connect; any other zuku: URI
  just focuses the window. No credential, path or command is ever read from the URI.
.EXAMPLE
  .\protocol-registration.ps1 -Register -Executable "$env:LOCALAPPDATA\ZukuJS\releases\cli-0.3.0-abcdef012345\studio\windows\ZukuStudio.exe"
  .\protocol-registration.ps1 -Unregister -Executable <same path>
#>
[CmdletBinding(DefaultParameterSetName = 'Register')]
param(
    [Parameter(ParameterSetName = 'Register', Mandatory)][switch]$Register,
    [Parameter(ParameterSetName = 'Unregister', Mandatory)][switch]$Unregister,
    [Parameter(Mandatory)][string]$Executable
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Executable -notmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFileName($Executable) -ne 'ZukuStudio.exe') { throw 'Executable must be the absolute path of ZukuStudio.exe.' }
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw 'ZukuStudio.exe not found.' }
$Executable = [IO.Path]::GetFullPath($Executable)
if ($Executable.Contains('"') -or $Executable.Contains('%')) { throw 'Unsupported characters in the executable path.' }

$key = 'Software\Classes\zuku'
$command = '"' + $Executable + '" "%1"'
$hkcu = [Microsoft.Win32.Registry]::CurrentUser

function Get-Existing {
    $open = $hkcu.OpenSubKey("$key\shell\open\command")
    if ($null -eq $open) { return $null }
    try { return [string]$open.GetValue('') } finally { $open.Dispose() }
}

$existing = Get-Existing
if ($Unregister) {
    if ($null -eq $existing) { Write-Host 'zuku: protocol is not registered for this user.'; return }
    if ($existing -ne $command) { throw 'The zuku: protocol belongs to another program; it was left unchanged.' }
    $hkcu.DeleteSubKeyTree($key, $false)
    Write-Host 'Removed the per-user zuku: protocol registration.'
    return
}

if ($null -ne $existing -and $existing -ne $command) {
    $previous = $existing -replace '^"([^"]+)".*$', '$1'
    if ([IO.Path]::GetFileName($previous) -ne 'ZukuStudio.exe') { throw 'The zuku: protocol belongs to another program; it was left unchanged.' }
}
$root = $hkcu.CreateSubKey($key)
try {
    $root.SetValue('', 'URL:ZUKU Studio')
    $root.SetValue('URL Protocol', '')
    $icon = $root.CreateSubKey('DefaultIcon'); try { $icon.SetValue('', '"' + $Executable + '",0') } finally { $icon.Dispose() }
    $open = $root.CreateSubKey('shell\open\command'); try { $open.SetValue('', $command) } finally { $open.Dispose() }
} finally { $root.Dispose() }
Write-Host 'Registered zuku: for the current user (HKCU) -> ZukuStudio.exe.'
