# Generates launcher/app.ico from the Android adaptive-icon design so the Windows
# launcher matches the phone app icon. Reproduces the vector exactly:
#   background  #1A1A2E (bg_dark)
#   foreground  #FF6B6B ring (outer circle r24, inner hole r12) + 4 triangular ticks
# on the 108x108 viewport from android/.../ic_launcher_foreground.xml.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File tools/make-icon.ps1

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$out   = Join-Path $PSScriptRoot '..\launcher\app.ico'
$sizes = 16,24,32,48,64,128,256
$bg    = [System.Drawing.Color]::FromArgb(255,0x1A,0x1A,0x2E)
$fg    = [System.Drawing.Color]::FromArgb(255,0xFF,0x6B,0x6B)

function New-IconBitmap([int]$s) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $scale = $s / 108.0

    # Rounded-square background (app-icon look).
    $d = [int]($s * 0.36)   # corner diameter
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    if ($d -gt 1) {
        $max = $s - 1
        $path.AddArc(0,        0,        $d, $d, 180, 90)
        $path.AddArc($max-$d,  0,        $d, $d, 270, 90)
        $path.AddArc($max-$d,  $max-$d,  $d, $d,   0, 90)
        $path.AddArc(0,        $max-$d,  $d, $d,  90, 90)
        $path.CloseFigure()
    } else {
        $path.AddRectangle((New-Object System.Drawing.Rectangle(0,0,$s,$s)))
    }
    $bgBrush = New-Object System.Drawing.SolidBrush($bg)
    $g.FillPath($bgBrush, $path)

    $fgBrush = New-Object System.Drawing.SolidBrush($fg)
    # Ring: outer circle (30,30,48,48), then punch the hole (42,42,24,24) with bg.
    $g.FillEllipse($fgBrush, 30*$scale, 30*$scale, 48*$scale, 48*$scale)
    $g.FillEllipse($bgBrush, 42*$scale, 42*$scale, 24*$scale, 24*$scale)

    # Four triangular ticks (top, bottom, left, right).
    $tris = @(
        @(@(54,18),@(50,32),@(58,32)),
        @(@(54,90),@(50,76),@(58,76)),
        @(@(18,54),@(32,50),@(32,58)),
        @(@(90,54),@(76,50),@(76,58))
    )
    foreach ($t in $tris) {
        $pts = foreach ($p in $t) { New-Object System.Drawing.PointF(($p[0]*$scale), ($p[1]*$scale)) }
        $g.FillPolygon($fgBrush, [System.Drawing.PointF[]]$pts)
    }

    $g.Dispose()
    return $bmp
}

# Render each size to PNG bytes.
$pngs = @()
foreach ($s in $sizes) {
    $bmp = New-IconBitmap $s
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += , ($ms.ToArray())
    $bmp.Dispose(); $ms.Dispose()
}

# Assemble a PNG-framed .ico (Windows Vista+ reads PNG entries at every size).
$fs = New-Object System.IO.FileStream($out, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)  # ICONDIR
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $len = $pngs[$i].Length
    $dim = [Byte]($(if ($s -ge 256) { 0 } else { $s }))
    $bw.Write($dim); $bw.Write($dim)        # width, height (0 == 256)
    $bw.Write([Byte]0); $bw.Write([Byte]0)  # colors, reserved
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)  # planes, bpp
    $bw.Write([UInt32]$len); $bw.Write([UInt32]$offset)
    $offset += $len
}
foreach ($data in $pngs) { $bw.Write($data) }
$bw.Flush(); $bw.Close(); $fs.Close()

Write-Host "wrote $out ($($sizes.Count) sizes)"
