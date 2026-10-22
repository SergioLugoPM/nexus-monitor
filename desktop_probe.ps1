# Muestreador de ventanas para Nexus Monitor (SOLO LECTURA).
# Lo lanza server.js bajo demanda (ruta /desktop) y se apaga solo: imprime una línea JSON cada
# IntervalMs con las ventanas de aplicación visibles y no minimizadas que tocan la pantalla
# principal. No modifica ninguna configuración del sistema ni escribe estructuras de Win32:
# solo EnumWindows / GetWindowRect (un RECT de 4 enteros, "out") / GetWindowText.
# Termina cuando el proceso padre (el backend) deja de existir, para no quedar huérfano.
param([int]$ParentPid = 0, [int]$IntervalMs = 2000)

$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NxWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int sz);
  public static string Snapshot() {
    int sw = GetSystemMetrics(0), sh = GetSystemMetrics(1);
    var sb = new StringBuilder();
    sb.Append("{\"w\":").Append(sw).Append(",\"h\":").Append(sh).Append(",\"wins\":[");
    bool first = true;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      int cloaked = 0; DwmGetWindowAttribute(h, 14, out cloaked, 4);
      if (cloaked != 0) return true;                                  // ocultas de otros escritorios virtuales o UWP suspendidas
      int ex = GetWindowLong(h, -20);
      if ((ex & 0x80) != 0 && (ex & 0x40000) == 0) return true;       // ventana de herramientas
      if (GetWindow(h, 4) != IntPtr.Zero) return true;                // con dueño (diálogos hijos)
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      string title = t.ToString();
      if (title.Length == 0) return true;
      var c = new StringBuilder(128); GetClassName(h, c, 128);
      string cls = c.ToString();
      if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      int L = Math.Max(r.Left, 0), T = Math.Max(r.Top, 0), R = Math.Min(r.Right, sw), B = Math.Min(r.Bottom, sh);
      if (R <= L || B <= T) return true;
      if ((long)(R - L) * (B - T) < 14400) return true;               // menos de 120x120 px
      if (!first) sb.Append(',');
      first = false;
      sb.Append("{\"t\":\"");
      foreach (char ch in title) { if (ch == (char)34 || ch == (char)92 || ch < 32) sb.Append(' '); else sb.Append(ch); }
      sb.Append("\",\"c\":\"").Append(cls).Append("\",\"l\":").Append(L).Append(",\"tp\":").Append(T).Append(",\"r\":").Append(R).Append(",\"b\":").Append(B).Append("}");
      return true;
    }, IntPtr.Zero);
    sb.Append("]}");
    return sb.ToString();
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp

while ($true) {
  if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  [Console]::Out.WriteLine([NxWin]::Snapshot())
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $IntervalMs
}
