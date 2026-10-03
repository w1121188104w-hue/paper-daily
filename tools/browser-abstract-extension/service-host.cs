using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

namespace PaperDaily {
    // Compiled as a Windows (GUI) executable: the task itself has no console.
    // Workers and their Node children also use CREATE_NO_WINDOW explicitly.
    public static class ServiceHost {
        public static int RunHidden(string executable, string arguments, string directory) {
            var info = new ProcessStartInfo(executable, arguments) {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = directory,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using (var child = new Process { StartInfo = info }) {
                if (!child.Start()) return 1;
                child.StandardInput.Close();
                // Drain both pipes without storing raw output or credentials.
                Task output = child.StandardOutput.BaseStream.CopyToAsync(Stream.Null);
                Task error = child.StandardError.BaseStream.CopyToAsync(Stream.Null);
                child.WaitForExit();
                Task.WaitAll(output, error);
                return child.ExitCode;
            }
        }

        [STAThread]
        public static int Main(string[] args) {
            string role = null, dataRoot = null;
            try {
                if (args.Length != 6 || args[0] != "-Role" || args[2] != "-Script" || args[4] != "-DataRoot") return 2;
                role = args[1];
                string script = args[3];
                dataRoot = args[5];
                if ((role != "Workflow" && role != "Review") || !Path.IsPathRooted(script) || !File.Exists(script) ||
                    !Path.IsPathRooted(dataRoot) || !Directory.Exists(dataRoot) || script.Contains("\"") || dataRoot.Contains("\"")) return 2;
                var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
                var command = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + script + "\"" +
                    (role == "Workflow" ? " -Worker" : "") + " -DataRoot \"" + dataRoot.TrimEnd('\\', '/') + "\"";
                return RunHidden(powershell, command, Environment.CurrentDirectory);
            } catch {
                // Fixed code only; errors and child output never become logs.
                try {
                    if ((role == "Workflow" || role == "Review") && dataRoot != null && Path.IsPathRooted(dataRoot)) {
                        string logs = Path.Combine(dataRoot, "PaperDailyWorkflow", "service-logs");
                        Directory.CreateDirectory(logs);
                        File.AppendAllText(Path.Combine(logs, role.ToLowerInvariant() + ".log"),
                            DateTime.UtcNow.ToString("o") + " " + role + " pid=" + Process.GetCurrentProcess().Id + " HOST_START_FAILED" + Environment.NewLine);
                    }
                } catch { }
                return 1;
            }
        }
    }
}
