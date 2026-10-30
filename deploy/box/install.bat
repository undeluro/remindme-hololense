@echo off
rem Installs or updates the Kinly backend's Python packages in C:\kinly\venv from requirements.txt (exported from
rem backend/uv.lock). Run by the on-demand task kinly-install (SYSTEM); log C:\kinly\logs\install.log.
setlocal
set ROOT=C:\kinly
set PYTHONUTF8=1
set UV_CACHE_DIR=%ROOT%\cache\uv
set LOG=%ROOT%\logs\install.log
echo [%date% %time%] install start >> "%LOG%"
if not exist "%ROOT%\venv\Scripts\python.exe" "C:\Program Files\Python312\python.exe" -m venv "%ROOT%\venv" >> "%LOG%" 2>&1
"%ROOT%\venv\Scripts\python.exe" -m pip install --disable-pip-version-check uv >> "%LOG%" 2>&1
"%ROOT%\venv\Scripts\uv.exe" pip install --python "%ROOT%\venv\Scripts\python.exe" -r "%ROOT%\deploy\requirements.txt" >> "%LOG%" 2>&1
echo [%date% %time%] install exit code %ERRORLEVEL% >> "%LOG%"
rem The backend's OpenAI settings: its own token of the box gateway (client kinly-box) and the gateway address, written
rem into backend\.env on the box itself, so the token never leaves it. Skipped when .env already exists.
if exist "%ROOT%\backend\.env" goto :eof
echo # Kinly backend settings on the box. Never commit, never print.> "%ROOT%\backend\.env"
"C:\Program Files\Python312\python.exe" C:\openai-budget\gw_client_env.py kinly-box "%ROOT%\backend\.env" >> "%LOG%" 2>&1
echo [%date% %time%] gateway client exit code %ERRORLEVEL% >> "%LOG%"
