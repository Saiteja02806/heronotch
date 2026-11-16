using System;
using System.Threading;
using Windows.Foundation;
using Windows.Storage.Streams;
using Windows.Media.Control;

// Notch: read the current album-art thumbnail from a Windows media session
// (System Media Transport Controls). PowerShell 5.1 cannot project these
// WinRT stream types, so the read happens here in C# (.NET Framework 4.8,
// built-in WinRT projection).
//
// Rebuild with:
//   csc -nologo -t:library -out:resources/notch-media-art.dll
//     -r:C:\Windows\System32\WinMetadata\Windows.Storage.winmd
//     -r:C:\Windows\System32\WinMetadata\Windows.Media.winmd
//     -r:C:\Windows\System32\WinMetadata\Windows.Foundation.winmd
//     -r:<GAC_MSIL>\System.Runtime.WindowsRuntime\v4.0_4.0.0.0__b77a5c561934e089\System.Runtime.WindowsRuntime.dll
//     -r:<GAC_MSIL>\System.Runtime\v4.0_4.0.0.0__b03f5f7f11d50a3a\System.Runtime.dll
//     resources/notch-media-art.cs

public static class NotchMediaArt {
  static T Wait<T>(IAsyncOperation<T> op) {
    var done = new ManualResetEvent(false);
    op.Completed = (operation, status) => { done.Set(); };
    done.WaitOne(5000);
    return op.GetResults();
  }

  /// <summary>
  /// The album art of the session's current track as PNG/JPEG bytes, or null
  /// when the app exposes no thumbnail.
  /// </summary>
  public static byte[] Read(object sessionObj) {
    var session = (GlobalSystemMediaTransportControlsSession)sessionObj;
    var props = Wait(session.TryGetMediaPropertiesAsync());
    if (props.Thumbnail == null) return null;
    var stream = Wait(props.Thumbnail.OpenReadAsync());
    using (var reader = new DataReader(stream)) {
      uint size = (uint)Math.Min((double)stream.Size, 4194304.0);
      var bytes = new byte[size];
      Wait(reader.LoadAsync(size));
      reader.ReadBytes(bytes);
      return bytes;
    }
  }
}
