import Cocoa

// Prints one JSON object per on-screen window owned by the given app.
let owner = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "QQ"
let options = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { exit(1) }
for window in list {
  guard let name = window["kCGWindowOwnerName"] as? String, name == owner else { continue }
  let bounds = window["kCGWindowBounds"] as? [String: Any] ?? [:]
  let payload: [String: Any] = [
    "id": window["kCGWindowNumber"] ?? 0,
    "owner": name,
    "name": window["kCGWindowName"] ?? "",
    "x": bounds["X"] ?? 0,
    "y": bounds["Y"] ?? 0,
    "width": bounds["Width"] ?? 0,
    "height": bounds["Height"] ?? 0,
  ]
  if let data = try? JSONSerialization.data(withJSONObject: payload), let text = String(data: data, encoding: .utf8) {
    print(text)
  }
}
