# 大肥鱼发布运行手册

## 启动服务

```sh
npm run connect:service:start
npm run connect:service:status
```

状态应显示 `installed=true` 和 `loaded=true`。

## 检查 Magic5

```sh
/opt/homebrew/bin/adb devices -l
npm run connect:status
```

发布检查要求 Magic5 在线，Companion 的通知读取、Listener 和 Overlay 状态正常。

## 设备离线处理

1. 保持手机解锁并连接 USB。
2. 确认 USB 调试授权提示已接受。
3. 运行 `/opt/homebrew/bin/adb devices -l`。
4. 运行 `npm run connect:status`。
5. 等待设备重新出现在 Connect 状态中。
6. 运行 `npm run stability:summary`，确认新采样继续写入。

设备断开期间不执行抖音、微信或其他外部操作。断开期间产生的任务必须保持未知状态，恢复后先观察环境再重新规划。

## 发布检查

```sh
npm test
npm run stability:summary
npm run release:check
```

发布检查必须同时满足：

- 完整测试通过。
- Magic5 在线。
- 没有未决未知或派发中的设备命令。
- 没有运行中或已批准但未完成的外部任务。
- 稳定性窗口至少168小时。
- 跟踪文件中没有密钥。

## 当前记录

当前代码测试和安全检查已通过。Magic5 物理连接恢复后，稳定性窗口需要从已有覆盖继续累积到168小时。历史采样不会被补写或伪造。
