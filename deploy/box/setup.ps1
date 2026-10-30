# Kinly on the Hetzner box: folders, firewall rule, scheduled tasks, then the package install.
# Expects the files in C:\kinly (backend\ and deploy\, sent by deploy/box/push.sh) and Caddy 2.11+ at
# C:\kinly\caddy\caddy.exe. Safe to run again: rules and tasks are replaced, nothing is deleted.
$Root = 'C:\kinly'
foreach ($d in 'logs', 'cache', 'caddy\data') { New-Item -ItemType Directory -Force -Path (Join-Path $Root $d) | Out-Null }
if (-not (Test-Path "$Root\caddy\caddy.exe")) { throw "Put caddy.exe (v2.11 or later) into $Root\caddy first" }

# Only the Caddy port faces the internet; the backend itself listens on 127.0.0.1:8821.
if (-not (Get-NetFirewallRule -DisplayName 'kinly 8822' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'kinly 8822' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8822 | Out-Null
}

# schtasks /create would stop the services after 72 hours (the default limit), so the tasks are registered here.
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
foreach ($name in 'backend', 'caddy') {
    Register-ScheduledTask -TaskName "kinly-$name" -Action (New-ScheduledTaskAction -Execute "$Root\deploy\run_$name.bat") `
        -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $principal -Settings $settings -Force | Out-Null
}
Register-ScheduledTask -TaskName 'kinly-install' -Action (New-ScheduledTaskAction -Execute "$Root\deploy\install.bat") `
    -Principal $principal -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName 'kinly-install'
Get-ScheduledTask -TaskName 'kinly-*' | Select-Object TaskName, State | Format-Table -AutoSize
