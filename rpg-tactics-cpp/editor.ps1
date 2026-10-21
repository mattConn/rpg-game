param([Parameter(ValueFromRemainingArguments=$true)][string[]]$EditorArguments)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $env:PATH = "C:\msys64\mingw64\bin;$env:PATH"
    if (!(Test-Path 'build/rpg-tactics-editor.exe')) { & ./build.ps1 -Target editor }
    & ./build/rpg-tactics-editor.exe --editor @EditorArguments
    if ($LASTEXITCODE -ne 0) { throw "Native editor exited with code $LASTEXITCODE" }
} finally { Pop-Location }
