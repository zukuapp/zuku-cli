using System;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Zuku.Studio.Core;

namespace Zuku.Studio;

/// <summary>
/// One Studio per user session. The first instance owns a session-local mutex and listens on a
/// named pipe whose DACL grants only the current user (network logons explicitly denied). Later
/// launches (CLI `zuku studio`, the zuku://ai/connect handler) send one bounded LaunchRequest and exit.
/// No credential, path authority or command crosses this channel; a project path is only a picker hint.
/// </summary>
sealed class SingleInstance : IDisposable
{
    readonly Mutex mutex;
    readonly CancellationTokenSource stop = new();

    SingleInstance(Mutex mutex, bool primary) { this.mutex = mutex; Primary = primary; }

    public bool Primary { get; }

    static string Suffix
    {
        get
        {
            var sid = WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException("no user SID");
            return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("zuku-studio/1:" + sid)))[..24];
        }
    }
    public static string MutexName => @"Local\ZukuStudio-" + Suffix;
    public static string PipeName => "ZukuStudio-" + Suffix;

    public static SingleInstance Acquire()
    {
        var mutex = new Mutex(true, MutexName, out var created);
        return new SingleInstance(mutex, created);
    }

    public static PipeSecurity Security()
    {
        var user = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("no user SID");
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        return security;
    }

    public static NamedPipeServerStream CreateServer(string name) =>
        NamedPipeServerStreamAcl.Create(name, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, LaunchRequest.WireBytes, 0, Security());

    /// <summary>Accepts launch requests until disposed; each is delivered on the caller's dispatcher via onRequest.</summary>
    public void Listen(Action<LaunchRequest> onRequest)
    {
        if (!Primary) return;
        _ = Task.Run(async () =>
        {
            while (!stop.IsCancellationRequested)
            {
                try
                {
                    await using var server = CreateServer(PipeName);
                    await server.WaitForConnectionAsync(stop.Token).ConfigureAwait(false);
                    var request = await ReadAsync(server, stop.Token).ConfigureAwait(false);
                    if (request is not null) onRequest(request);
                }
                catch (OperationCanceledException) { return; }
                catch (IOException) { await Task.Delay(200).ConfigureAwait(false); }
                catch (UnauthorizedAccessException) { await Task.Delay(1000).ConfigureAwait(false); }
            }
        });
    }

    static async Task<LaunchRequest?> ReadAsync(Stream stream, CancellationToken token)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(2));
        var buffer = new byte[LaunchRequest.WireBytes + 1];
        var length = 0;
        try
        {
            int read;
            while (length < buffer.Length && (read = await stream.ReadAsync(buffer.AsMemory(length), timeout.Token).ConfigureAwait(false)) > 0) length += read;
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { return null; }
        return length is > 0 and <= LaunchRequest.WireBytes ? LaunchRequest.Decode(buffer.AsSpan(0, length)) : null;
    }

    /// <summary>Second instance: hand the request to the running Studio and let it take the foreground.</summary>
    public static bool Forward(LaunchRequest request)
    {
        var bytes = request.Encode();
        if (bytes.Length > LaunchRequest.WireBytes) return false;
        for (var attempt = 0; attempt < 10; attempt++)
        {
            try
            {
                // CurrentUserOnly: the client also verifies the pipe server runs as this user.
                using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out, PipeOptions.CurrentUserOnly);
                client.Connect(500);
                if (Native.GetNamedPipeServerProcessId(client.SafePipeHandle, out var serverProcess)) Native.AllowSetForegroundWindow((int)serverProcess);
                client.Write(bytes);
                client.Flush();
                return true;
            }
            catch (TimeoutException) { }
            catch (IOException) { Thread.Sleep(200); }
            catch (UnauthorizedAccessException) { return false; }
        }
        return false;
    }

    public void Dispose()
    {
        stop.Cancel();
        if (Primary) { try { mutex.ReleaseMutex(); } catch (ApplicationException) { } }
        mutex.Dispose();
        stop.Dispose();
    }
}
