@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  美乐地 - 安卓打包（需先装好 Android Studio）
echo ============================================
echo.
echo [1/2] 同步网页资源到安卓工程...
copy /Y "version.json" "cap-web\version.json" >nul
call npx cap sync android
if errorlevel 1 (
  echo 同步失败，请确认已运行 npm install 且网络正常。
  pause
  exit /b
)
echo.
echo [2/2] 打开 Android Studio（在里面点 Build - Build APK(s)）...
call npx cap open android
echo.
echo 打开后：菜单 Build - Build APK(s)，底部出现 app-release-unsigned.apk 即可传到手机安装。
pause
