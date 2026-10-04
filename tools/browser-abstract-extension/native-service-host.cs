using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Web.Script.Serialization;

public static class PaperDailyNativeServiceHost {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static byte[] ReadExact(Stream input, int size) {
        byte[] bytes = new byte[size]; int offset = 0;
        while (offset < size) { int n = input.Read(bytes, offset, size - offset); if (n == 0) throw new IOException(); offset += n; }
        return bytes;
    }
    static string Quote(string value) {
        if (String.IsNullOrWhiteSpace(value) || value.IndexOfAny(new char[] {'"', '\r', '\n'}) >= 0) throw new IOException();
        return "\"" + value + "\"";
    }
    static void Reply(bool ok, string code) {
        byte[] bytes = new UTF8Encoding(false).GetBytes(Json.Serialize(new { ok = ok, code = code }));
        Stream output = Console.OpenStandardOutput(); byte[] length = BitConverter.GetBytes(bytes.Length);
        output.Write(length, 0, 4); output.Write(bytes, 0, bytes.Length); output.Flush();
    }
    public static void Main(string[] args) {
        try {
            string configFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher.json");
            var config = Json.Deserialize<Dictionary<string,string>>(File.ReadAllText(configFile, Encoding.UTF8));
            if (args.Length < 1 || args[0] != config["origin"]) { Reply(false, "ORIGIN_REJECTED"); return; }
            Stream input = Console.OpenStandardInput(); int size = BitConverter.ToInt32(ReadExact(input, 4), 0);
            if (size < 2 || size > 4096) { Reply(false, "REQUEST_REJECTED"); return; }
            var request = Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(ReadExact(input, size)));
            if (request.Count != 1 || !request.ContainsKey("action") || !(request["action"] is string) || (string)request["action"] != "start_services") { Reply(false, "REQUEST_REJECTED"); return; }
            string script = config["script"], dataRoot = config["data_root"];
            if (!Path.IsPathRooted(script) || Path.GetFileName(script) != "manage-workflow-service.ps1" || !File.Exists(script) || !Directory.Exists(dataRoot)) { Reply(false, "INSTALLATION_MISSING"); return; }
            var start = new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
                Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " + Quote(script) + " -Mode Start -DataRoot " + Quote(dataRoot),
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            using (var process = Process.Start(start)) {
                process.OutputDataReceived += delegate {}; process.ErrorDataReceived += delegate {};
                process.BeginOutputReadLine(); process.BeginErrorReadLine();
                if (!process.WaitForExit(25000)) { process.Kill(); Reply(false, "START_TIMEOUT"); return; }
                Reply(process.ExitCode == 0, process.ExitCode == 0 ? "START_REQUESTED" : "START_FAILED");
            }
        } catch { Reply(false, "LAUNCHER_FAILED"); }
    }
}
