using System.Text.Json;
using System.Text.Json.Nodes;

namespace LanControl;

/// <summary>极简 JSON 工具，基于 System.Text.Json（BOM/反射均无需额外依赖）。</summary>
internal static class Json
{
    private static readonly JsonSerializerOptions Write = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static string Str(object? value) => JsonSerializer.Serialize(value, Write);

    public static JsonObject? Parse(string text)
    {
        try
        {
            return JsonNode.Parse(text) as JsonObject;
        }
        catch
        {
            return null;
        }
    }

    public static string GetString(JsonObject o, string key, string fallback = "")
        => o.TryGetPropertyValue(key, out var v) && v is not null ? v.ToString() : fallback;

    public static double GetDouble(JsonObject o, string key, double fallback = 0)
        => o.TryGetPropertyValue(key, out var v) && v is not null && double.TryParse(v.ToString(),
            System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d)
            ? d : fallback;

    public static int GetInt(JsonObject o, string key, int fallback = 0)
        => (int)GetDouble(o, key, fallback);

    public static bool GetBool(JsonObject o, string key, bool fallback = false)
        => o.TryGetPropertyValue(key, out var v) && v is not null && bool.TryParse(v.ToString(), out var b) ? b : fallback;
}
