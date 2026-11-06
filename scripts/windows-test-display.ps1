Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class Display {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2;
    public int dmPanningWidth, dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int ChangeDisplaySettings(ref DEVMODE dm, int flags);
}
'@
$dm = New-Object Display+DEVMODE
$dm.dmSize = [Runtime.InteropServices.Marshal]::SizeOf($dm)
[void][Display]::EnumDisplaySettings($null, -1, [ref]$dm)
$dm.dmPelsWidth = 1920
$dm.dmPelsHeight = 1080
$dm.dmFields = 0x180000
$result = [Display]::ChangeDisplaySettings([ref]$dm, 0)
Add-Type -AssemblyName System.Windows.Forms
Write-Host "ChangeDisplaySettings: $result, screen: $([System.Windows.Forms.Screen]::PrimaryScreen.Bounds)"
