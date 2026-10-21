param([Parameter(ValueFromRemainingArguments=$true)][string[]]$GameArguments)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $env:PATH = "C:\msys64\mingw64\bin;$env:PATH"
    if (!(Test-Path 'build/rpg-tactics-native.exe')) { & "$PSScriptRoot\build.ps1" }
    & "$PSScriptRoot\build\rpg-tactics-native.exe" @GameArguments
    if ($LASTEXITCODE -ne 0) { throw "Game exited with code $LASTEXITCODE" }
} finally { Pop-Location }
