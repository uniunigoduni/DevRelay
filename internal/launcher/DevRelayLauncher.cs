using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

[assembly: AssemblyTitle("DevRelay")]
[assembly: AssemblyProduct("DevRelay")]
[assembly: AssemblyDescription("DevRelay Windows launcher")]
[assembly: AssemblyCompany("DevRelay")]
[assembly: AssemblyVersion("0.4.1.0")]
[assembly: AssemblyFileVersion("0.4.1.0")]

internal static class Program
{
    private const string AppUserModelId = "DevRelay.Desktop";
    private static readonly PropertyKey AppIdKey = new PropertyKey(
        new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr hwnd, string text, string caption, uint type);

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropVariant value);

    [STAThread]
    private static int Main()
    {
        try
        {
            SetCurrentProcessExplicitAppUserModelID(AppUserModelId);
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            string bootstrap = Path.Combine(root, "internal", "gui", "Bootstrap-DevRelayGui.ps1");
            if (!File.Exists(bootstrap))
            {
                ShowError("DevRelay startup files were not found next to DevRelay.exe.");
                return 2;
            }

            string executable = Process.GetCurrentProcess().MainModule.FileName;
            TryEnsureStartMenuShortcut(executable, root);

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = "powershell.exe";
            startInfo.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + bootstrap + "\"";
            startInfo.WorkingDirectory = Path.Combine(root, "internal");
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(startInfo);
            return 0;
        }
        catch (Exception error)
        {
            ShowError("DevRelay could not start.\r\n\r\n" + error.Message);
            return 1;
        }
    }

    private static void TryEnsureStartMenuShortcut(string executable, string root)
    {
        object shellLinkObject = null;
        PropVariant appId = new PropVariant();
        try
        {
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            if (String.IsNullOrEmpty(programs)) return;
            string shortcutPath = Path.Combine(programs, "DevRelay.lnk");

            shellLinkObject = new ShellLink();
            IShellLinkW shellLink = (IShellLinkW)shellLinkObject;
            shellLink.SetPath(executable);
            shellLink.SetWorkingDirectory(root);
            shellLink.SetDescription("DevRelay");
            shellLink.SetIconLocation(executable, 0);
            shellLink.SetShowCmd(1);

            IPropertyStore properties = (IPropertyStore)shellLinkObject;
            appId = PropVariant.FromString(AppUserModelId);
            PropertyKey appIdKey = AppIdKey;
            int result = properties.SetValue(ref appIdKey, ref appId);
            if (result < 0) Marshal.ThrowExceptionForHR(result);
            result = properties.Commit();
            if (result < 0) Marshal.ThrowExceptionForHR(result);

            ((IPersistFile)shellLinkObject).Save(shortcutPath, true);
        }
        catch
        {
            // Shortcut creation is best-effort; DevRelay itself can still start.
        }
        finally
        {
            if (appId.PointerValue != IntPtr.Zero) PropVariantClear(ref appId);
            if (shellLinkObject != null && Marshal.IsComObject(shellLinkObject))
                Marshal.FinalReleaseComObject(shellLinkObject);
        }
    }

    private static void ShowError(string message)
    {
        MessageBoxW(IntPtr.Zero, message, "DevRelay", 0x00000010u);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct PropertyKey
    {
        public Guid FormatId;
        public uint PropertyId;

        public PropertyKey(Guid formatId, uint propertyId)
        {
            FormatId = formatId;
            PropertyId = propertyId;
        }
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct PropVariant
    {
        [FieldOffset(0)] public ushort VarType;
        [FieldOffset(8)] public IntPtr PointerValue;

        public static PropVariant FromString(string value)
        {
            PropVariant result = new PropVariant();
            result.VarType = 31; // VT_LPWSTR
            result.PointerValue = Marshal.StringToCoTaskMemUni(value);
            return result;
        }
    }

    [ComImport]
    [Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink
    {
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("000214F9-0000-0000-C000-000000000046")]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int maxPath, IntPtr findData, uint flags);
        void GetIDList(out IntPtr itemIdList);
        void SetIDList(IntPtr itemIdList);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int maxName);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int maxPath);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int maxPath);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int showCommand);
        void SetShowCmd(int showCommand);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath, int maxPath, out int iconIndex);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string relativePath, uint reserved);
        void Resolve(IntPtr hwnd, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
    }
}
