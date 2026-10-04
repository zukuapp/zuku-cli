#Requires -Version 5.1
<#
.SYNOPSIS
  Builds and verifies the ZUKU Studio Windows shell (WPF + WebView2, bundled .NET 10).
.DESCRIPTION
  1. Checks protocol-manifest.json against lib/agent-protocol/schema.mjs and studio/native/bridge.js.
  2. Runs the platform-neutral native protocol self-test, including the stdio group against the
     SYNTHETIC fixture tests/stdio-fixture.mjs (never the real Agent Core).
  3. Publishes ZukuStudio.exe with its .NET Windows Desktop runtime for the requested RID.
  4. Runs the published exe's --self-test and --stdio-test (Windows APIs: pipe ACL, Job Object).
  Nothing is installed, registered or signed here.
.PARAMETER Runtime
  win-x64 (default) or win-arm64.
.PARAMETER Node
  Absolute path to node.exe used only for the manifest check and the synthetic stdio fixture.
#>
[CmdletBinding()]
param(
    [ValidateSet('win-x64', 'win-arm64')][string]$Runtime = 'win-x64',
    [ValidateSet('Release', 'Debug')][string]$Configuration = 'Release',
    [string]$Node = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$repo = [IO.Path]::GetFullPath((Join-Path $here '..\..\..'))
$package = Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($package.name -ne '@zukujs/cli') { throw 'Unexpected repository: package.json is not @zukujs/cli.' }
$version = [string]$package.version

if (-not $Node) { $Node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
if ($Node -notmatch '^[A-Za-z]:\\') { throw 'Node must be an absolute drive path.' }

$dotnet = (Get-Command dotnet.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$sdk = & $dotnet --version
if ($LASTEXITCODE -ne 0 -or -not ($sdk -match '^(\d+)\.') -or [int]$Matches[1] -lt 10) { throw ".NET SDK 10 or newer is required (found '$sdk')." }

function Invoke-Checked([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$([IO.Path]::GetFileName($File)) failed with exit code $LASTEXITCODE." }
}

Write-Host '== protocol manifest drift check'
Invoke-Checked $Node @((Join-Path $here 'tools\protocol-manifest.mjs'), '--check')

$fixture = Join-Path $here 'tests\stdio-fixture.mjs'
Write-Host '== platform-neutral native protocol self-test (stdio group uses the SYNTHETIC fixture)'
Invoke-Checked $dotnet @('run', '--project', (Join-Path $here 'tests\ZukuStudio.Core.Tests\ZukuStudio.Core.Tests.csproj'), '-c', $Configuration, "-p:ZukuCliVersion=$version", '--', '--node', $Node, '--fixture', $fixture)

$out = Join-Path $here "build\$Runtime"
Write-Host "== publish ZukuStudio.exe ($Runtime, self-contained .NET 10 Windows Desktop)"
Invoke-Checked $dotnet @('publish', (Join-Path $here 'src\ZukuStudio\ZukuStudio.csproj'), '-c', $Configuration, '-r', $Runtime, '--self-contained', 'true', "-p:ZukuCliVersion=$version", '-o', $out)

$exe = Join-Path $out 'ZukuStudio.exe'
if (-not (Test-Path -LiteralPath (Join-Path $out 'WebView2Loader.dll')) -and -not (Test-Path -LiteralPath (Join-Path $out "runtimes\$Runtime\native\WebView2Loader.dll"))) { throw 'WebView2Loader.dll missing from publish output.' }
$hostArch = if ([Environment]::Is64BitOperatingSystem -and $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
if ($hostArch -eq $Runtime) {
    Write-Host '== published exe self-test (Windows pipe ACL, Job Object, folder policy)'
    $p = Start-Process -FilePath $exe -ArgumentList '--self-test' -NoNewWindow -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "ZukuStudio.exe --self-test failed ($($p.ExitCode))." }
    $p = Start-Process -FilePath $exe -ArgumentList @('--stdio-test', '--node', "`"$Node`"", '--fixture', "`"$fixture`"") -NoNewWindow -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "ZukuStudio.exe --stdio-test failed ($($p.ExitCode))." }
} else {
    Write-Host "== skipped running $Runtime binaries on a $hostArch host"
}
Write-Host "Built $exe (ZUKU CLI $version). Install layout: <release>\studio\windows\ beside install.json; see docs/studio-windows.md."
