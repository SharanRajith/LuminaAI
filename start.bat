@echo off
echo ============================================
echo   Lumina AI - Presentation ^& Report Maker
echo ============================================
echo.
cd /d "%~dp0"
echo Activating virtual environment...
call venv\Scripts\activate.bat
cd backend
echo [1/2] Installing / updating dependencies...
pip install -r requirements.txt --quiet
echo.
echo [2/2] Starting backend on http://localhost:8000
echo.
echo  Open this URL in your browser:
echo  http://localhost:8000
echo.
echo  Press Ctrl+C to stop the server.
echo.
python main.py
pause
