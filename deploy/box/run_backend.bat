@echo off
rem Kinly backend on 127.0.0.1:8821; Caddy publishes it as https://95.217.106.60:8822 (run_caddy.bat).
rem Started at boot by the task kinly-backend (SYSTEM, no time limit); restarts in 10 s if it exits.
rem Log: C:\kinly\logs\backend.log. Models download on the first start into C:\kinly\cache and C:\kinly\backend.
setlocal
set ROOT=C:\kinly
set PYTHONUTF8=1
set PYTHONUNBUFFERED=1
set HF_HOME=%ROOT%\cache\huggingface
set TORCH_HOME=%ROOT%\cache\torch
set DEEPFACE_HOME=%ROOT%\cache
set YOLO_CONFIG_DIR=%ROOT%\cache\ultralytics
cd /d "%ROOT%\backend"
:loop
echo [%date% %time%] backend start >> "%ROOT%\logs\backend.log"
"%ROOT%\venv\Scripts\python.exe" -u -m uvicorn main:app --host 127.0.0.1 --port 8821 >> "%ROOT%\logs\backend.log" 2>&1
echo [%date% %time%] backend exit code %ERRORLEVEL%, restart in 10 s >> "%ROOT%\logs\backend.log"
ping -n 11 127.0.0.1 > nul
goto loop
