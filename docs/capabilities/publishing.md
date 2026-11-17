# 发图文（publishing）

两次审核的发布链路：先生成内容存草稿（不碰手机），编号发给爸爸审；同意后才填抖音发布页并发出去。

入口：
- 动作：douyin.draft（scripts/douyin-post.mjs --plan）、douyin.publish_draft（--draft + douyin-confirm.mjs）
- 任务：proposeTask → approvePendingTask → startTask → markAwaitingPublish（stage=draft）
- 作品库：works 表；草稿 status='draft' 不占编号，发布时 publishDraft 补 DFY-xxxx
- 看板：内容页可编辑草稿（标题/正文/话题/设置/单图），点「发布到抖音」走 /api/board/draft/publish

状态：单图可发；多图补选未做通（DAFEIYU_MULTI_IMAGE=1 关着）。
已知坑：发布页「继续编辑作品」弹窗会让后续坐标点击落空。
