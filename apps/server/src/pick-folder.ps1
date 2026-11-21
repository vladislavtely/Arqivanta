$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ArqivantaFolderPicker
{
    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        // COM dispatch uses the declaration order from IModalWindow and IFileDialog.
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr filters);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        void GetFolder(out IShellItem folder);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName(out IntPtr name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
        void GetParent(out IShellItem item);
        void GetDisplayName(uint format, out IntPtr name);
    }

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    public static string Pick()
    {
        // Windows assigns the thread's DPI context to each new dialog window.
        IntPtr previousDpi = EnterDialogDpiContext();
        try
        {
            return ShowFolderDialog();
        }
        finally
        {
            if (previousDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpi);
        }
    }

    private static IntPtr EnterDialogDpiContext()
    {
        const int PerMonitorAwareV2 = -4;
        const int PerMonitorAware = -3;
        try
        {
            IntPtr previousDpi = SetThreadDpiAwarenessContext(new IntPtr(PerMonitorAwareV2));
            if (previousDpi != IntPtr.Zero) return previousDpi;
            return SetThreadDpiAwarenessContext(new IntPtr(PerMonitorAware));
        }
        catch (EntryPointNotFoundException)
        {
            return IntPtr.Zero;
        }
    }

    private static string ShowFolderDialog()
    {
        const uint PickFolders = 0x20;
        const uint ForceFileSystem = 0x40;
        const uint DontAddToRecent = 0x02000000;
        const uint FileSystemPath = 0x80058000;
        const int Cancelled = unchecked((int)0x800704C7);

        var dialogType = Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7"));
        var dialog = (IFileDialog)Activator.CreateInstance(dialogType);
        IShellItem selected = null;
        IntPtr path = IntPtr.Zero;
        try
        {
            uint options;
            dialog.GetOptions(out options);
            dialog.SetOptions(options | PickFolders | ForceFileSystem | DontAddToRecent);
            dialog.SetTitle("Select an Arqivanta project folder");
            dialog.SetOkButtonLabel("Select folder");
            int result = dialog.Show(IntPtr.Zero);
            if (result == Cancelled) return null;
            Marshal.ThrowExceptionForHR(result);

            dialog.GetResult(out selected);
            selected.GetDisplayName(FileSystemPath, out path);
            return Marshal.PtrToStringUni(path);
        }
        finally
        {
            if (path != IntPtr.Zero) Marshal.FreeCoTaskMem(path);
            if (selected != null) Marshal.ReleaseComObject(selected);
            Marshal.ReleaseComObject(dialog);
        }
    }
}
'@

$folder = [ArqivantaFolderPicker]::Pick()
if ($null -ne $folder) { [Console]::WriteLine($folder) }
