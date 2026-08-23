param([switch]$auto)

$b = $PSScriptRoot
$w = Join-Path $b 'cap-web'

Write-Host '============================================'
Write-Host '  一键打包 - 美乐地'
Write-Host '============================================'

Write-Host '[1/4] 同步网页资源...'
Remove-Item (Join-Path $w '*') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force (Join-Path $b 'css') (Join-Path $w 'css')
Copy-Item -Recurse -Force (Join-Path $b 'js') (Join-Path $w 'js')
foreach ($f in 'index.html','manifest.json','sw.js','icon.svg','icon-192.png','icon-512.png') {
  Copy-Item -Force (Join-Path $b $f) (Join-Path $w $f)
}
$assets = Join-Path $b 'android\app\src\main\assets\public'
Remove-Item (Join-Path $assets '*') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force (Join-Path $w '*') $assets

Write-Host '[2/4] 构建 APK（大约 2 分钟，请耐心等）...'
$env:JAVA_HOME = Join-Path $env:USERPROFILE 'jdk17\jdk-17.0.20+8'
$env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
Set-Location (Join-Path $b 'android')
& .\gradlew.bat assembleDebug --no-daemon
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '!!! 构建失败，请把上面的错误信息复制给 AI 助手 !!!'
  if (-not $auto) { Read-Host '按回车退出' }
  exit 1
}

Write-Host '[3/4] 复制 APK 到桌面...'
$apk = Join-Path $b 'android\app\build\outputs\apk\debug\app-debug.apk'
$out = Join-Path ([Environment]::GetFolderPath('Desktop')) (([string][char]0x7F8E + [char]0x4E50 + [char]0x5730) + '.apk')
Copy-Item $apk $out -Force

Write-Host '[4/4] 完成！桌面上的 美乐地.apk 已更新，传到手机安装即可。'
if (-not $auto) { Read-Host '按回车退出' }
