using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
using Zuku.Studio.Core;

namespace Zuku.Studio;

static class Native
{
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AttachConsole(int processId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AllowSetForegroundWindow(int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint processId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetInformationJobObject(SafeFileHandle job, int informationClass, ref ExtendedLimitInformation information, int length);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, char[] path, uint length, uint flags);

    public const int AttachParentProcess = -1;

    [StructLayout(LayoutKind.Sequential)]
    public struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
}

/// <summary>
/// Kill-on-close Job Object: when Studio exits (even by crash) the OS terminates the stdio
/// host and every process it started (builds, previews), so nothing outlives the window.
/// </summary>
sealed class ProcessJob : IDisposable
{
    const int ExtendedLimitInformationClass = 9;
    const uint KillOnJobClose = 0x00002000;
    readonly SafeFileHandle handle;

    public ProcessJob()
    {
        handle = Native.CreateJobObjectW(IntPtr.Zero, null);
        if (handle.IsInvalid) throw new InstallationException("STUDIO_JOB_UNAVAILABLE");
        var information = new Native.ExtendedLimitInformation { BasicLimitInformation = new Native.BasicLimitInformation { LimitFlags = KillOnJobClose } };
        if (!Native.SetInformationJobObject(handle, ExtendedLimitInformationClass, ref information, Marshal.SizeOf<Native.ExtendedLimitInformation>()))
        {
            handle.Dispose();
            throw new InstallationException("STUDIO_JOB_UNAVAILABLE");
        }
    }

    public void Assign(Process process)
    {
        if (!Native.AssignProcessToJobObject(handle, process.Handle)) throw new InstallationException("STUDIO_JOB_UNAVAILABLE");
    }

    public void Terminate() { if (!handle.IsClosed) Native.TerminateJobObject(handle, 1); }

    public void Dispose() => handle.Dispose();
}

static class FolderAccess
{
    const uint FileShareAll = 0x1 | 0x2 | 0x4;
    const uint OpenExisting = 3;
    const uint BackupSemantics = 0x02000000;

    /// <summary>
    /// The OS-resolved final path of a picked folder. Refuses network paths and any selection
    /// that resolves elsewhere (junction, symlink, short name), so the host gets exactly what the user saw.
    /// </summary>
    public static string? Canonical(string selected, out string reason)
    {
        reason = "PROJECT_PATH_INVALID";
        if (selected.Length > 4096 || !Path.IsPathFullyQualified(selected) || !Directory.Exists(selected)) return null;
        using var handle = Native.CreateFileW(selected, 0, FileShareAll, IntPtr.Zero, OpenExisting, BackupSemantics, IntPtr.Zero);
        if (handle.IsInvalid) return null;
        var buffer = new char[32768];
        var length = Native.GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Length, 0);
        if (length == 0 || length >= buffer.Length) return null;
        var final = new string(buffer, 0, (int)length);
        if (final.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) { reason = "PROJECT_PATH_NETWORK"; return null; }
        if (final.StartsWith(@"\\?\", StringComparison.Ordinal)) final = final[4..];
        if (!string.Equals(final.TrimEnd('\\'), Path.GetFullPath(selected).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) { reason = "PROJECT_PATH_LINK"; return null; }
        return final;
    }

    public static FolderPolicy.Roots Roots()
    {
        string Folder(Environment.SpecialFolder folder) => Environment.GetFolderPath(folder, Environment.SpecialFolderOption.DoNotVerify);
        var forbidden = new[] { Environment.SpecialFolder.Windows, Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.CommonApplicationData }
            .Select(Folder).Where(path => path.Length > 3).ToList();
        return new FolderPolicy.Roots(Folder(Environment.SpecialFolder.UserProfile), forbidden);
    }
}

/// <summary>
/// The installation is trusted only if no principal other than the current user, SYSTEM,
/// Administrators or TrustedInstaller can modify the files Studio loads or executes.
/// </summary>
static class TrustedFiles
{
    const string TrustedInstaller = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    const FileSystemRights Write = FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.WriteExtendedAttributes
        | FileSystemRights.WriteAttributes | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles
        | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
    const FileSystemRights Rename = FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;

    public static void Verify(Installation installation)
    {
        var user = WindowsIdentity.GetCurrent().User ?? throw new InstallationException("STUDIO_ACL_UNSAFE");
        var trusted = new HashSet<string>(StringComparer.Ordinal) { user.Value, "S-1-5-18", "S-1-5-32-544", TrustedInstaller };
        var files = new List<string> { installation.NodePath, installation.HostEntry, Path.Combine(installation.PackageRoot, "package.json"), Path.Combine(installation.ReleaseRoot, "install.json") };
        files.AddRange(InstallLocator.ServedAssets.Values.Select(relative => Path.Combine(installation.PackageRoot, relative.Replace('/', '\\'))));
        files.Add(Path.Combine(installation.PackageRoot, InstallLocator.BridgeFile.Replace('/', '\\')));
        var directories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in files)
        {
            Check(new FileInfo(file).GetAccessControl(), Write, trusted);
            for (var directory = Path.GetDirectoryName(file); directory is not null && directory.StartsWith(installation.ReleaseRoot, StringComparison.OrdinalIgnoreCase); directory = Path.GetDirectoryName(directory))
                if (directories.Add(directory)) Check(new DirectoryInfo(directory).GetAccessControl(), Write, trusted);
        }
        // Ancestors above the release only need to be safe from being renamed or re-permissioned by others.
        for (var directory = Path.GetDirectoryName(installation.ReleaseRoot); directory is not null && Path.GetDirectoryName(directory) is not null; directory = Path.GetDirectoryName(directory))
            Check(new DirectoryInfo(directory).GetAccessControl(), Rename, trusted);
    }

    static void Check(FileSystemSecurity security, FileSystemRights dangerous, HashSet<string> trusted)
    {
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow || rule.PropagationFlags.HasFlag(PropagationFlags.InheritOnly)) continue;
            const int GenericAllOrWrite = 0x10000000 | 0x40000000;
            if ((rule.FileSystemRights & dangerous) == 0 && ((int)rule.FileSystemRights & GenericAllOrWrite) == 0) continue;
            if (!trusted.Contains(((SecurityIdentifier)rule.IdentityReference).Value)) throw new InstallationException("STUDIO_ACL_UNSAFE");
        }
    }
}
