import Cocoa
import Foundation

// 每隔一秒打印一行：当前微信 / QQ 的窗口标题，用 | 分隔。
// 空行表示没有窗口（或都不可见）。Node 侧据此判断是否在通话。

let interval: TimeInterval = 1.0

func scan() -> String {
    let options = CGWindowListOption(arrayLiteral: .optionOnScreenOnly)
    var titles: [String] = []
    if let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] {
        for window in list {
            let owner = window["kCGWindowOwnerName"] as? String ?? ""
            guard owner.contains("微信") || owner.contains("WeChat") || owner.contains("QQ") else { continue }
            let name = window["kCGWindowName"] as? String ?? ""
            if !name.isEmpty { titles.append(name) }
        }
    }
    return titles.joined(separator: "|")
}

while true {
    print(scan())
    fflush(stdout)
    Thread.sleep(forTimeInterval: interval)
}
