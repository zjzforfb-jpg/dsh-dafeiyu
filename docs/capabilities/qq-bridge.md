# QQ 通道（qq-bridge）

WebSocket 网关收发；service.handle 做审批、规划、回复；active/被动消息规则下群主动消息会被拒（40034105），用 qq_outbox 排队借被动窗口补发。

入口：
- QqService.handle；approveTask / approveFromBoard / cancelFromBoard
- api.sendText / sendImage / sendVoice；POST /qq/send、/qq/image
- 审批词：同意/确认/执行/可以/好的/好/发/发布/发吧/发咯/发出去

已知坑：网关半死连接会一直显示 online（缺心跳看门狗，建议补）。
