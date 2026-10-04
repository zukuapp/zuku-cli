using System;
using System.IO;
using System.Threading.Tasks;
using Zuku.Studio.Core;

// Exit code = number of failed checks (0 = pass). --node and --fixture enable the stdio
// group, which talks to the SYNTHETIC tests/stdio-fixture.mjs, never the real Agent Core.
string? node = null, fixture = null;
for (var i = 0; i + 1 < args.Length; i += 2)
{
    if (args[i] == "--node") node = Path.GetFullPath(args[i + 1]);
    else if (args[i] == "--fixture") fixture = Path.GetFullPath(args[i + 1]);
    else { Console.Error.WriteLine("usage: [--node <path> --fixture <stdio-fixture.mjs>]"); return 64; }
}
var failed = await SelfTest.RunAsync(Console.Out, node, fixture);
return Math.Min(failed, 63);
