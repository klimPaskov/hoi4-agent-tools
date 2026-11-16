# One line of machine load for the nightly benchmark log (Windows): total CPU, free memory, and the
# processes that used the most CPU over a two-second window. Project tooling, not a packaged
# command. The nightly ran several times slower than the same command by hand with nothing
# scheduled at that hour, so the log records what else was busy while it ran.
$ErrorActionPreference = 'SilentlyContinue'
$before = @{}
foreach ($process in Get-Process) { $before[$process.Id] = $process.CPU }
$cpu = (Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 2 -MaxSamples 1).CounterSamples[0].CookedValue
$busy = foreach ($process in Get-Process) {
  if ($before.ContainsKey($process.Id) -and $null -ne $process.CPU) {
    [pscustomobject]@{ Name = $process.ProcessName; Seconds = $process.CPU - $before[$process.Id] }
  }
}
$top = $busy | Where-Object { $_.Seconds -gt 0.05 } | Sort-Object Seconds -Descending | Select-Object -First 8 |
  ForEach-Object { '{0} {1:N1}s' -f $_.Name, $_.Seconds }
$free = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB
'load {0:yyyy-MM-ddTHH:mm:ss} cpu {1:N0}% free {2:N1} GB top: {3}' -f (Get-Date), $cpu, $free, ($top -join ', ')
