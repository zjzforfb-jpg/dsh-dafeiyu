# 大肥鱼 3D 角色（Blender 程序化建模）

网页中间那只 3D 大肥鱼，是用脚本在 Blender 里"长"出来的，没有任何手改模型文件。

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib_mesh.py` | 几何工具：椭球 / 旋转体 / 管道 / 平面贴片 / 双面片 / 椭球投影贴片 / 贝塞尔曲线，顶点色直接写进 `Col` 属性 |
| `build_character.py` | 角色本体：头、脸（分层大眼）、头发（整片刘海 + 侧发 + 呆毛）、鲸鱼耳鳍、水手领、围裙 + 鲸鱼徽章、裙 + 衬裙、手臂、白袜、靴、尾巴。坐标 Z 向上，面朝 -Y，身高 2.6 |
| `export_json.py` | 建好 → join → 三角化 → 坐标转成 three.js 的 (x, z, -y) → 顶点色 sRGB uint8 + 位置 int16 量化 → base64 JSON |
| `../web/assets/dafeiyu-mesh.json` | 导出结果（约 16k 顶点 / 29.6k 三角 / 430KB） |

## 常用命令

```bash
cd docs/capabilities/blender

# 四个视图预览（front / 3q / side / head，EEVEE 渲染到 /tmp/dyN_*.png）
/Applications/Blender.app/Contents/MacOS/Blender -b --python build_character.py -- --render /tmp/dy

# 存成 .blend 方便手动检查
/Applications/Blender.app/Contents/MacOS/Blender -b --python build_character.py -- --blend /tmp/dy.blend

# 导出给网页
/Applications/Blender.app/Contents/MacOS/Blender -b --python export_json.py -- /tmp/dafeiyu_mesh.json
cp /tmp/dafeiyu_mesh.json ../web/assets/dafeiyu-mesh.json

# 重建单文件网页（默认只用原画，不注入 3D 模型）
cd ../../.. && node scripts/build-capabilities-page.mjs

# 想用 3D 模型当主角时：
FISH_MESH=on node scripts/build-capabilities-page.mjs
```

## 网页侧怎么用的

`web/app.js` 里 `buildFishGeometry()` 解 base64 → `BufferGeometry`（`position` int16 / `col` uint8 sRGB→linear / `index` uint16）
→ 自定义着色器（三段明暗 + 冷色边缘光 + 一点高光），`side: DoubleSide`（模型的刘海、围裙、耳鳍都是单面片）。
模型缩放 4.32/2.60，脚底对齐 y=-2.16，跟随鼠标轻微转头（`fishSpin.rotation`），呼吸缩放。
模型**默认不参与构建**（页面用原画 `assets/dafeiyu.webp`）。用 `FISH_MESH=on` 构建后，中间会换成 3D 模型，
右上角出现「3D 模型 / 插画」切换按钮；
<=760px 的窄屏不跑 WebGL，直接走卡片列表。

## 调参提示

- 颜色全在 `build_character.py` 顶部的 `SKIN / HAIR_* / NAVY / WHITE / ...`，`srgb()` 负责 hex → 线性。
- 五官是投影到头部椭球的平面贴片（`face()` 里），眼睛分 9 层叠加；改大小改 `ex, ez` 与各层半径。
- 头发条纹在 `hair_col()`（`streak` 那条正弦），刘海下缘形状在 `edge_z()`。
- 渲染设置 `setup_render()`：默认 EEVEE + Standard 视图变换。**不要用 Workbench**，它的 STUDIO 灯 + cavity 会把肤色压成灰。
