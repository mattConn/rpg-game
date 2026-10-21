param([string]$Toolchain = 'C:\msys64\mingw64')
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $env:PATH = "$Toolchain\bin;$env:PATH"
    if (!(Test-Path "$Toolchain\bin\g++.exe")) { throw "Install the MSYS2 MinGW64 C++ toolchain first." }
    New-Item -ItemType Directory -Path build -Force | Out-Null
    & "$Toolchain\bin\g++.exe" '-std=c++20' '-O3' '-DNDEBUG' '-Wall' '-Wextra' '-Wpedantic' 'src/native.cpp' "-I$Toolchain/include/SDL2" "-L$Toolchain/lib" '-lSDL2' '-lSDL2_image' '-lSDL2_ttf' '-o' 'build/rpg-tactics-native.exe'
    if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
    Write-Output "Built $PSScriptRoot\build\rpg-tactics-native.exe"
} finally { Pop-Location }
