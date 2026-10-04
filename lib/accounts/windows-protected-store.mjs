import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AccountError } from './errors.mjs';

// Fixed program; file paths and secrets travel only through stdin, never command arguments.
// Windows PowerShell 5.1/.NET DPAPI CurrentUser; no plaintext file fallback.
const PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$stage = 'compile'
try {
  Add-Type -AssemblyName System.Security
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class ZukuProtectedFile {
  static FileSecurity PrivateFile(SecurityIdentifier sid) {
    var acl = new FileSecurity(); acl.SetOwner(sid); acl.SetAccessRuleProtection(true, false);
    acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow)); return acl;
  }
  public static FileStream CreatePrivateFile(string p, SecurityIdentifier sid) {
    return new FileStream(p, FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.WriteThrough, PrivateFile(sid));
  }
  public static void ReplaceFile(string source, string destination) {
    // Keep a real CLR null here: Windows PowerShell converts a null string
    // argument to an empty backup filename before invoking File.Replace.
    File.Replace(source, destination, null);
  }
  public static void CreatePrivateDirectory(string p, SecurityIdentifier sid) {
    if (Directory.Exists(p)) return;
    var parent = Path.GetDirectoryName(p);
    if (!String.IsNullOrEmpty(parent) && !Directory.Exists(parent)) CreatePrivateDirectory(parent, sid);
    var acl = new DirectorySecurity(); acl.SetOwner(sid); acl.SetAccessRuleProtection(true, false);
    acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
    Directory.CreateDirectory(p, acl);
    Check(p, true);
    // Apply to newly created components only. Existing user/system ancestors stay unchanged.
    Directory.SetAccessControl(p, acl);
  }
  public static void Protect(string p, bool directory, SecurityIdentifier sid) {
    Check(p, directory);
    if (directory) {
      var acl = new DirectorySecurity(); acl.SetOwner(sid); acl.SetAccessRuleProtection(true, false);
      acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
      Directory.SetAccessControl(p, acl);
    } else File.SetAccessControl(p, PrivateFile(sid));
    Verify(p, directory, sid);
  }
  public static void Verify(string p, bool directory, SecurityIdentifier sid) {
    Check(p, directory);
    // Read only owner/DACL information. No audit/SACL privilege is requested.
    FileSystemSecurity acl = directory
      ? (FileSystemSecurity)Directory.GetAccessControl(p, AccessControlSections.Owner | AccessControlSections.Access)
      : File.GetAccessControl(p, AccessControlSections.Owner | AccessControlSections.Access);
    if (!acl.GetOwner(typeof(SecurityIdentifier)).Equals(sid) || !acl.AreAccessRulesProtected) throw new Exception("unsafe");
    var rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier));
    if (rules.Count != 1) throw new Exception("unsafe");
    var rule = rules[0] as FileSystemAccessRule;
    if (rule == null || !rule.IdentityReference.Equals(sid) || rule.IsInherited || rule.AccessControlType != AccessControlType.Allow || rule.FileSystemRights != FileSystemRights.FullControl) throw new Exception("unsafe");
    Check(p, directory);
  }
  [StructLayout(LayoutKind.Sequential)] public struct Info {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
    public System.Runtime.InteropServices.ComTypes.FILETIME Access; public System.Runtime.InteropServices.ComTypes.FILETIME Write;
    public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string p, uint access, uint share, IntPtr sa, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle h, StringBuilder path, uint capacity, uint flags);
  public static void Check(string p, bool directory) {
    using (var h = CreateFile(p, 0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      Info i; if (h.IsInvalid || !GetFileInformationByHandle(h, out i)) throw new Exception("unsafe");
      if ((i.Attributes & 0x400) != 0 || ((i.Attributes & 0x10) != 0) != directory || (!directory && i.Links != 1)) throw new Exception("unsafe");
      var b = new StringBuilder(32768); var n = GetFinalPathNameByHandle(h, b, (uint)b.Capacity, 0);
      if (n == 0 || n >= b.Capacity || !String.Equals(b.ToString(), @"\\?\" + p, StringComparison.OrdinalIgnoreCase)) throw new Exception("unsafe");
    }
  }
}
'@
  $stage = 'request'
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $file = [IO.Path]::GetFullPath([string]$request.filePath)
  if ($file.Length -gt 4096 -or $file -notmatch '^[A-Za-z]:\\' -or $file.Substring(3) -match ':' -or ($file -split '\\' | Where-Object { $_ -match '[. ]$' })) { throw 'unsafe' }
  $directory = [IO.Path]::GetDirectoryName($file)
  function Protect([string]$p, [bool]$dir) {
    $script:stage = 'acl-write'
    [ZukuProtectedFile]::Protect($p, $dir, $sid)
  }
  function ZukuProtectedFile-Check([string]$p, [bool]$dir) { [ZukuProtectedFile]::Check($p, $dir) }
  function Verify([string]$p, [bool]$dir) {
    $script:stage = 'acl-owner'
    [ZukuProtectedFile]::Verify($p, $dir, $sid)
  }
  function EnsureDirectory {
    if ([IO.Directory]::Exists($directory)) { Verify $directory $true }
    else {
      $script:stage = 'create-directory'
      [ZukuProtectedFile]::CreatePrivateDirectory($directory, $sid)
      # Win32 creation may retain the elevated token's default owner. Apply our
      # explicit descriptor only to this newly created directory, then verify it.
      Protect $directory $true
    }
  }
  function FileExists([string]$p) {
    if (Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue) { Verify $p $false; return $true }
    return $false
  }
  $entropy = [Text.Encoding]::UTF8.GetBytes('ZukuJS protected local credentials v1')
  $result = @{ ok = $true }
  switch ([string]$request.action) {
    'ensure-directory' { EnsureDirectory }
    'read' {
      if (-not [IO.Directory]::Exists($directory)) { $result.data = $null; break }
      Verify $directory $true
      if (-not (FileExists $file)) { $result.data = $null; break }
      if ((Get-Item -LiteralPath $file).Length -gt 3145728) { throw 'unsafe' }
      $cipher = [IO.File]::ReadAllBytes($file)
      $plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      if ($plain.Length -gt 2097152) { throw 'unsafe' }
      $result.data = (New-Object Text.UTF8Encoding($false, $true)).GetString($plain)
      [Array]::Clear($plain, 0, $plain.Length)
    }
    'write' {
      EnsureDirectory
      $exists = FileExists $file
      $plain = [Text.Encoding]::UTF8.GetBytes([string]$request.data)
      if ($plain.Length -gt 2097152) { throw 'unsafe' }
      $cipher = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Array]::Clear($plain, 0, $plain.Length)
      $temp = $file + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
      try {
        $stream = [ZukuProtectedFile]::CreatePrivateFile($temp, $sid)
        try { $stream.Write($cipher, 0, $cipher.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        Protect $temp $false
        if ($exists) { Verify $file $false; [ZukuProtectedFile]::ReplaceFile($temp, $file) }
        else { [IO.File]::Move($temp, $file) }
        Verify $file $false
      } finally { if ($temp -and [IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
    }
    'remove' {
      if (-not [IO.Directory]::Exists($directory)) { break }
      Verify $directory $true
      if (FileExists $file) { [IO.File]::Delete($file) }
    }
    'acquire' {
      EnsureDirectory
      $lock = $file + '.lock'
      if (FileExists $lock) { $result = @{ ok = $false; code = 'busy' }; break }
      try { $stream = [ZukuProtectedFile]::CreatePrivateFile($lock, $sid) }
      catch { if ([IO.File]::Exists($lock)) { $result = @{ ok = $false; code = 'busy' }; break }; throw }
      try { $bytes = [Text.Encoding]::UTF8.GetBytes([string]$request.lease); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
      Protect $lock $false
    }
    'release' {
      Verify $directory $true
      $lock = $file + '.lock'
      if (-not (FileExists $lock) -or (Get-Item -LiteralPath $lock).Length -gt 64 -or [IO.File]::ReadAllText($lock) -cne [string]$request.lease) { throw 'unsafe' }
      [IO.File]::Delete($lock)
    }
    default { throw 'unsafe' }
  }
  [Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 4))
} catch {
  # Fixed exception class and numeric HRESULT carry no exception text or user data.
  $cause = $_.Exception.GetBaseException()
  $kind = $cause.GetType().Name
  if ($kind -notin @('UnauthorizedAccessException', 'ArgumentException', 'IOException', 'SecurityException', 'Exception', 'InvalidOperationException', 'NotSupportedException', 'MethodInvocationException', 'MethodException', 'RuntimeException', 'TypeNotFoundException', 'PSArgumentException', 'ParentContainsErrorRecordException')) { $kind = 'Other' }
  $errorId = [string]$_.FullyQualifiedErrorId
  if ($errorId -notmatch '^[A-Za-z0-9_.]{1,96},Microsoft.PowerShell.Commands.(?:SetAcl|GetAcl)Command$') { $errorId = 'Other' }
  [Console]::Out.Write((@{ ok = $false; code = 'unsafe'; stage = $stage; kind = $kind; hresult = $cause.HResult; line = $_.InvocationInfo.ScriptLineNumber; errorId = $errorId } | ConvertTo-Json -Compress))
  exit 1
}
`;

async function invoke(action, filePath, extra = {}, signal) {
  if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED');
  if (process.platform !== 'win32' || typeof filePath !== 'string' || !path.win32.isAbsolute(filePath) || filePath.length > 4096 || /[\x00-\x1f]/.test(filePath)) throw new AccountError('ZUKU_ACCOUNT_UNSAFE');
  const systemRoot = process.env.SystemRoot;
  // Do not let an environment override select a program that receives credentials on stdin.
  if (!systemRoot || path.win32.normalize(systemRoot).toLowerCase() !== 'c:\\windows') throw new AccountError('ZUKU_ACCOUNT_UNSAFE');
  const executable = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  return new Promise((resolve, reject) => {
    // Microsoft documents UTF-16LE EncodedCommand for programs with nested quoting.
    // This is fixed source only; credentials and paths still travel solely on stdin.
    const fixedProgram = Buffer.from(PROGRAM, 'utf16le').toString('base64');
    if (fixedProgram.length > 31000) return reject(new AccountError('ZUKU_ACCOUNT_UNSAFE'));
    // A PS7 parent can inject incompatible or user-writable module paths into
    // Windows PowerShell 5.1. Only its fixed system modules may see this stdin.
    const environment = { ...process.env, PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' };
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', fixedProgram], { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', size = 0, settled = false;
    const timer = setTimeout(() => finish(new AccountError('ZUKU_ACCOUNT_UNSAFE')), 30000);
    const abort = () => finish(new AccountError('COMMAND_CANCELLED'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    function finish(error, value) {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { child.kill(); reject(error); } else resolve(value);
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { size += Buffer.byteLength(data); if (size > 8 * 1024 * 1024) finish(new AccountError('ZUKU_ACCOUNT_UNSAFE')); else stdout += data; });
    child.stderr.on('data', () => {}); // PowerShell diagnostics can contain input; never expose them.
    child.on('error', () => finish(new AccountError('ZUKU_ACCOUNT_UNSAFE')));
    child.stdin.on('error', () => finish(new AccountError('ZUKU_ACCOUNT_UNSAFE')));
    child.on('close', code => {
      let result;
      try { result = JSON.parse(stdout); } catch { return finish(new AccountError('ZUKU_ACCOUNT_UNSAFE')); }
      if (code !== 0 || result?.ok !== true) {
        const error = new AccountError(result?.code === 'busy' ? 'ZUKU_ACCOUNT_BUSY' : 'ZUKU_ACCOUNT_UNSAFE');
        // Only fixed operation metadata is useful for platform diagnostics. PowerShell
        // exceptions, paths, SID values and plaintext never leave the protected peer.
        if (['compile', 'request', 'path', 'acl-owner', 'acl-rules', 'acl-rule-add', 'acl-write', 'create-directory'].includes(result?.stage)) error.message += ` (${result.stage})`;
        if (['UnauthorizedAccessException', 'ArgumentException', 'IOException', 'SecurityException', 'Exception', 'InvalidOperationException', 'NotSupportedException', 'MethodInvocationException', 'MethodException', 'RuntimeException', 'TypeNotFoundException', 'PSArgumentException', 'ParentContainsErrorRecordException', 'Other'].includes(result?.kind) && Number.isInteger(result?.hresult) && result.hresult >= -2147483648 && result.hresult <= 2147483647) error.message += ` [${result.kind}:${(result.hresult >>> 0).toString(16)}]`;
        if (Number.isSafeInteger(result?.line) && result.line > 0 && result.line <= 300) error.message += ` @${result.line}`;
        if (typeof result?.errorId === 'string' && /^[A-Za-z0-9_.]{1,96},Microsoft\.PowerShell\.Commands\.(?:SetAcl|GetAcl)Command$/.test(result.errorId)) error.message += ` ${result.errorId}`;
        return finish(error);
      }
      finish(null, result.data ?? null);
    });
    // No credentials in argv, environment, temporary script files or inherited stdout.
    child.stdin.end(JSON.stringify({ action, filePath, ...extra }));
  });
}

export async function readProtectedStore(filePath) { const data = await invoke('read', filePath); if (data !== null && typeof data !== 'string') throw new AccountError('ZUKU_ACCOUNT_UNSAFE'); return data; }
export async function writeProtectedStore(filePath, plaintext) { if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > 2 * 1024 * 1024) throw new AccountError('ZUKU_ACCOUNT_UNSAFE'); await invoke('write', filePath, { data: plaintext }); }
export async function removeProtectedStore(filePath) { await invoke('remove', filePath); }
/** Create or verify a SID-only directory; an existing unsafe directory is never adopted. */
export async function ensureProtectedStoreDirectory(directory) { await invoke('ensure-directory', path.join(directory, 'directory.dpapi')); }
export async function withProtectedStoreLock(filePath, operation, { signal, timeoutMs = 30000 } = {}) {
  if (typeof operation !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new AccountError('ZUKU_ACCOUNT_UNSAFE');
  const lease = randomUUID(), until = Date.now() + timeoutMs;
  while (true) {
    try { await invoke('acquire', filePath, { lease }, signal); break; }
    catch (error) {
      if (error.code !== 'ZUKU_ACCOUNT_BUSY' || Date.now() >= until || signal?.aborted) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try { return await operation(); } finally { await invoke('release', filePath, { lease }); }
}
