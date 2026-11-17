# 手机自动化（device-layer）

设备 uiautomator2 服务（127.0.0.1:19008 → 设备 9008）+ adb 输入/截图；device/douyin.mjs 封装导航、解析、点击。

入口：resetDouyin、backToFeed、openCommentInbox、openVideoComments、parseComments、parseCommentsWithLikes、sendInCurrentComposer、parseOwnWorkStats、dumpXml（uia.mjs）

已知缺口：没有弹窗/阻断检测；点击后无后置断言（P0 要补）。
