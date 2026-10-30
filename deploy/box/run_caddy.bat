@echo off
rem HTTPS and WSS in front of the Kinly backend: Caddy on port 8822, certificate for 95.217.106.60 from Let's Encrypt.
rem Started at boot by the task kinly-caddy (SYSTEM, no time limit); restarts in 10 s if it exits.
rem Log: C:\kinly\logs\caddy.log, certificates: C:\kinly\caddy\data
setlocal
set ROOT=C:\kinly
cd /d "%ROOT%\caddy"
:loop
echo [%date% %time%] caddy start >> "%ROOT%\logs\caddy.log"
"%ROOT%\caddy\caddy.exe" run --config "%ROOT%\deploy\Caddyfile" --adapter caddyfile >> "%ROOT%\logs\caddy.log" 2>&1
echo [%date% %time%] caddy exit code %ERRORLEVEL%, restart in 10 s >> "%ROOT%\logs\caddy.log"
ping -n 11 127.0.0.1 > nul
goto loop
