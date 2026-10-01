using System.Text;

namespace LanControl;

/// <summary>文件服务：目录列举、下载、上传、重命名、删除、新建文件夹。</summary>
internal static class FileService
{
    public static readonly string[] RootAliases = { "此电脑", "桌面", "下载", "文档", "图片", "视频", "音乐" };

    public static string ResolveAlias(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return "";
        if (path == "此电脑" || path == "/" || path == "\\") return "::drives";
        string user = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return path switch
        {
            "桌面" => Path.Combine(user, "Desktop"),
            "下载" => Path.Combine(user, "Downloads"),
            "文档" => Path.Combine(user, "Documents"),
            "图片" => Path.Combine(user, "Pictures"),
            "视频" => Path.Combine(user, "Videos"),
            "音乐" => Path.Combine(user, "Music"),
            _ => path,
        };
    }

    public static object ListDirectory(string path, string root)
    {
        path = ResolveAlias(path);
        var items = new List<object>();
        string current = path;
        if (path == "::drives")
        {
            foreach (var d in DriveInfo.GetDrives())
            {
                try
                {
                    if (!d.IsReady) continue;
                    items.Add(new
                    {
                        name = d.Name.TrimEnd('\\'),
                        path = d.RootDirectory.FullName,
                        dir = true,
                        size = 0L,
                        modified = "",
                        ext = "",
                    });
                }
                catch { }
            }
            return new { type = "dir", path = "::drives", parent = "", items, shortcuts = Shortcuts() };
        }

        var di = new DirectoryInfo(path);
        if (!di.Exists)
            return new { type = "dir", path, parent = "", items = Array.Empty<object>(), shortcuts = Shortcuts(), error = "目录不存在" };

        try
        {
            foreach (var d in di.EnumerateDirectories().OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase))
            {
                if ((d.Attributes & FileAttributes.System) != 0 || (d.Attributes & FileAttributes.Hidden) != 0) continue;
                items.Add(new { name = d.Name, path = d.FullName, dir = true, size = 0L, modified = d.LastWriteTime.ToString("yyyy-MM-dd HH:mm"), ext = "" });
            }
            foreach (var f in di.EnumerateFiles().OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase))
            {
                if ((f.Attributes & FileAttributes.Hidden) != 0 || (f.Attributes & FileAttributes.System) != 0) continue;
                items.Add(new { name = f.Name, path = f.FullName, dir = false, size = f.Length, modified = f.LastWriteTime.ToString("yyyy-MM-dd HH:mm"), ext = f.Extension.TrimStart('.').ToLowerInvariant() });
            }
        }
        catch (Exception ex)
        {
            return new { type = "dir", path, parent = ParentOf(path), items, shortcuts = Shortcuts(), error = ex.Message };
        }

        return new { type = "dir", path, parent = ParentOf(path), items, shortcuts = Shortcuts() };
    }

    public static IEnumerable<object> Shortcuts()
    {
        string user = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var list = new List<object> { new { name = "此电脑", path = "::drives" } };
        void Add(string name, string p) { if (Directory.Exists(p)) list.Add(new { name, path = p }); }
        Add("桌面", Path.Combine(user, "Desktop"));
        Add("下载", Path.Combine(user, "Downloads"));
        Add("文档", Path.Combine(user, "Documents"));
        Add("图片", Path.Combine(user, "Pictures"));
        Add("视频", Path.Combine(user, "Videos"));
        Add("音乐", Path.Combine(user, "Music"));
        return list;
    }

    private static string ParentOf(string path)
    {
        try
        {
            var parent = Directory.GetParent(path);
            return parent?.FullName ?? "::drives";
        }
        catch { return "::drives"; }
    }

    public static (bool ok, string message, string path) CreateDirectory(string parent, string name)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(name)) return (false, "名称不能为空", "");
            parent = ResolveAlias(parent);
            var target = Path.Combine(parent, name.Trim());
            Directory.CreateDirectory(target);
            return (true, "已创建文件夹", target);
        }
        catch (Exception ex) { return (false, ex.Message, ""); }
    }

    public static (bool ok, string message) Delete(string path)
    {
        try
        {
            path = ResolveAlias(path);
            if (Directory.Exists(path)) Directory.Delete(path, true);
            else if (File.Exists(path)) File.Delete(path);
            else return (false, "目标不存在");
            return (true, "已删除");
        }
        catch (Exception ex) { return (false, ex.Message); }
    }

    public static (bool ok, string message, string path) Rename(string path, string newName)
    {
        try
        {
            path = ResolveAlias(path);
            if (Directory.Exists(path))
            {
                var target = Path.Combine(Path.GetDirectoryName(path)!, newName);
                Directory.Move(path, target);
                return (true, "已重命名", target);
            }
            if (File.Exists(path))
            {
                var target = Path.Combine(Path.GetDirectoryName(path)!, newName);
                File.Move(path, target);
                return (true, "已重命名", target);
            }
            return (false, "目标不存在", "");
        }
        catch (Exception ex) { return (false, ex.Message, ""); }
    }

    public static string ContentType(string fileName)
    {
        string ext = Path.GetExtension(fileName).ToLowerInvariant();
        return ext switch
        {
            ".txt" or ".log" or ".md" or ".ini" or ".cfg" => "text/plain; charset=utf-8",
            ".html" or ".htm" => "text/html; charset=utf-8",
            ".json" => "application/json; charset=utf-8",
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".bmp" => "image/bmp",
            ".svg" => "image/svg+xml",
            ".mp4" => "video/mp4",
            ".mp3" => "audio/mpeg",
            ".pdf" => "application/pdf",
            ".zip" => "application/zip",
            ".apk" => "application/vnd.android.package-archive",
            _ => "application/octet-stream",
        };
    }

    /// <summary>解析 multipart/form-data，返回首个文件的文件名与内容。</summary>
    public static (string fileName, byte[] data)? ParseSingleFileUpload(byte[] body, string boundary)
    {
        if (body.Length == 0 || string.IsNullOrEmpty(boundary)) return null;
        var delim = Encoding.ASCII.GetBytes("--" + boundary);
        int pos = IndexOf(body, delim, 0);
        while (pos >= 0)
        {
            int lineEnd = IndexOf(body, Encoding.ASCII.GetBytes("\r\n\r\n"), pos);
            if (lineEnd < 0) return null;
            var headerText = Encoding.UTF8.GetString(body, pos, lineEnd - pos);
            int dataStart = lineEnd + 4;
            int next = IndexOf(body, delim, dataStart);
            if (next < 0) return null;
            int dataEnd = next;
            if (dataEnd >= 2 && body[dataEnd - 2] == '\r' && body[dataEnd - 1] == '\n') dataEnd -= 2;

            string fileName = "";
            foreach (var line in headerText.Split("\r\n"))
            {
                if (line.StartsWith("Content-Disposition", StringComparison.OrdinalIgnoreCase))
                {
                    int i = line.IndexOf("filename=\"", StringComparison.OrdinalIgnoreCase);
                    if (i >= 0)
                    {
                        i += 10;
                        int j = line.IndexOf('"', i);
                        if (j > i) fileName = line[i..j];
                    }
                }
            }
            if (!string.IsNullOrEmpty(fileName))
            {
                var data = new byte[dataEnd - dataStart];
                Buffer.BlockCopy(body, dataStart, data, 0, data.Length);
                return (fileName, data);
            }
            pos = next;
        }
        return null;
    }

    public static List<(string name, string value)> ParseFormFields(byte[] body, string boundary)
    {
        var result = new List<(string, string)>();
        if (body.Length == 0 || string.IsNullOrEmpty(boundary)) return result;
        var delim = Encoding.ASCII.GetBytes("--" + boundary);
        int pos = IndexOf(body, delim, 0);
        while (pos >= 0)
        {
            int lineEnd = IndexOf(body, Encoding.ASCII.GetBytes("\r\n\r\n"), pos);
            if (lineEnd < 0) break;
            var headerText = Encoding.UTF8.GetString(body, pos, lineEnd - pos);
            int dataStart = lineEnd + 4;
            int next = IndexOf(body, delim, dataStart);
            if (next < 0) break;
            int dataEnd = next;
            if (dataEnd >= 2 && body[dataEnd - 2] == '\r' && body[dataEnd - 1] == '\n') dataEnd -= 2;
            if (!headerText.Contains("filename=", StringComparison.OrdinalIgnoreCase))
            {
                int i = headerText.IndexOf("name=\"", StringComparison.OrdinalIgnoreCase);
                if (i >= 0)
                {
                    i += 6;
                    int j = headerText.IndexOf('"', i);
                    if (j > i)
                        result.Add((headerText[i..j], Encoding.UTF8.GetString(body, dataStart, dataEnd - dataStart)));
                }
            }
            pos = next;
        }
        return result;
    }

    private static int IndexOf(byte[] haystack, byte[] needle, int start)
    {
        if (needle.Length == 0) return -1;
        for (int i = Math.Max(start, 0); i <= haystack.Length - needle.Length; i++)
        {
            bool ok = true;
            for (int j = 0; j < needle.Length; j++)
                if (haystack[i + j] != needle[j]) { ok = false; break; }
            if (ok) return i;
        }
        return -1;
    }
}
