# 运行看板（board）

http://127.0.0.1:8765/board ；M3 深色，hash 路由五页。

入口：
- boardSnapshot / boardList（connect/board.mjs）；路由 /api/board、/api/board/list、/board/cover、/api/board/activity、/api/board/draft*、/api/board/mood
- 前端 shell + modules（connect/board/modules/*.mjs）；模块契约 meta + mount(host, ctx)
- 新增页面：modules/index.mjs 加一行；新增数据：board.mjs 加 section

风格来源：docs/prototype/board-m3.html（1:1 移植的蓝本）。
