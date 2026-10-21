param([string]$Toolchain = 'C:\msys64\mingw64', [string]$Target = 'game')
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $env:PATH = "$Toolchain\bin;$env:PATH"
    if (!(Test-Path "$Toolchain\bin\g++.exe")) { throw "Install the MSYS2 MinGW64 C++ toolchain first." }
    New-Item -ItemType Directory -Path build -Force | Out-Null
    if ($Target -notin @('game', 'editor', 'staged')) { throw 'Target must be game, editor, or staged.' }
    $output = if ($Target -eq 'editor') { 'build/rpg-tactics-editor.exe' } elseif ($Target -eq 'staged') { 'build/rpg-tactics-next.exe' } else { 'build/rpg-tactics-native.exe' }
    & "$Toolchain\bin\g++.exe" '-std=c++20' '-O3' '-DNDEBUG' '-Wall' '-Wextra' '-Wpedantic' 'src/native.cpp' "-I$Toolchain/include/SDL2" "-L$Toolchain/lib" '-lSDL2' '-lSDL2_image' '-lSDL2_ttf' '-lcomdlg32' '-o' $output
    if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
    Write-Output "Built $PSScriptRoot\$output"
} finally { Pop-Location }
