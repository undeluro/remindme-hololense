# Restarts the Kinly backend on the box after deploy/box/push.sh. Ending the task stops only run_backend.bat, so the
# Python tree it started (the venv launcher, the interpreter and the Whisper worker) is ended too, then the task
# starts again and loads the new code.
Stop-ScheduledTask -TaskName 'kinly-backend'
$own = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -like '*uvicorn main:app --host 127.0.0.1 --port 8821*' }
foreach ($p in $own) { taskkill /T /F /PID $p.ProcessId 2>$null | Out-Null }
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName 'kinly-backend'
Get-ScheduledTask -TaskName 'kinly-backend' | Select-Object TaskName, State | Format-Table -AutoSize
