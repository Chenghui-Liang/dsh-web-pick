# dsh-web-pick

在 DeepSeek Harness **内置浏览器（右侧栏 Browser）**里点选网页元素、拖框选一块区域，把整批**放进对话输入框**——检查、改完再自己按回车发送。

装完即用，不改被看的项目一行代码。

## 安装

```sh
dsh plugin --profile desktop add github:Chenghui-Liang/dsh-web-pick
```

装完**完整退出并重启一次** DSH（Client 半在 host 启动时组装），然后在右侧栏打开内置浏览器、访问任意页面。

> 只适用于 **DSH Desktop** 的内置浏览器：桌面版用 Electron `<webview>` 承载页面，插件的 Client 半和它同处一个文档，才能注入选取层。Web 版浏览器是 iframe，插件够不到页面 DOM，因此在那里不生效。

## 用法

页面**右下角**有一个 **「选取」** 小胶囊：

1. 点它进入选取模式，鼠标移到哪，哪就高亮，并显示 `div · 920×1307 · #1f2328 · 14px` 这样的元素信息。
2. **点一下元素** → 立刻在元素下方弹出小卡片，可以补一句说明；也可直接「保存」不留说明。弹卡片期间，元素的高亮框和尺寸标一直留在页面上（滚动时跟着走）。
3. **按住拖动** → 框选一块区域，松手同样**当场弹出卡片**；虚线的选区框也留在原地，方便对照着写这块要改什么。
4. 每条保存后，胶囊右边数字 +1；点开是列表（定位 / 编辑说明 / 删除 / 清空）。
5. 点 **「放入输入框」** —— 整批写成一段文字**塞进对话输入框**（用编辑器自己的 `insertText`，不覆盖你已经打的字），每条截图则像**粘贴图片**一样挂进输入框的附件栏。**不会自动发送**，你检查/删改后自己按回车。
6. `Esc` 退出选取模式或关掉卡片。

放进去的文字大概是这个形状：

```text
【网页选取】2 条 · GitHub - Chenghui-Liang
页面：https://github.com/Chenghui-Liang
截图：2 张（已附在下面）

1. 元素 div `#id` 「保存」 · 字号大一点
   源码：src/pages/Budget.tsx:42
2. 区域 320×180 · 这块留白太大
```

截图怎么进的输入框：不去碰编辑器内部状态，而是找到输入框自己的 `<input type="file">`，用 `DataTransfer` 装好图片、触发它的 `change` —— 和用户点「+」选文件走的是同一条 intake 通道，所以缩略图、上传进度、删除按钮都是原生行为。

选取按「页面」分开存（`sessionStorage`，key 是 origin + pathname）：刷新页面还在，跳到别的页面各存各的。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半：`GET /dsh-web-pick/overlay.js`（每次现读文件，改完不用重启）、`POST /report`、`POST /batch`、`GET /status`，以及 `webpick_status` 诊断工具。 |
| `client.js` | Client 半：扫描 `<webview>`、注入 overlay、每 700ms 收一次选取、裁截图，再把截图塞进输入框附件栏、把文字 `insertText` 进输入框。 |
| `web/overlay.js` | 注入页面里的选取层（纯 IIFE，Shadow DOM 隔离，无依赖）。 |

## 原理（为什么不用改站点）

桌面版的内置浏览器用 Electron `<webview>` 承载页面，页面处在独立 origin，GUI 里的插件够不到它的 DOM。但插件的 Client 半就跑在 GUI 页面里，和 `<webview>` 同处一个文档，于是：

```js
webview.executeJavaScript(overlay)    // 注入选取层
webview.executeJavaScript(outbox())   // 每 700ms 取回选取
webview.capturePage()                 // 每条一张裁剪截图
```

写输入框用的是 slot 自带的 `inputActions`（`insertText` / `setDraft` / `persistDraft`），不调 `session.prompt`，所以消息不会直接发出去。

不需要反向代理、不需要 CDP、不需要往项目里加 `<script>`，任意 URL 都能用。入口是页面里的浮层，因为内置浏览器的工具栏归它自己所有，插件拿不到那个槽位（`ctx.sidebarRight` 不对外开放）。

## 已知限制

- 只能标顶层文档：跨域 iframe 里的元素标不到。
- 内置浏览器面板关掉/切走后 `webview` 不在 DOM 里，选取层随之暂停（回来会重新注入）。
- SPA 内部路由切换后，旧条目的定位可能失效（列表里点定位会提示）。
- 单批最多 6 张截图，超出部分只写文字。
- 输入框里已有内容时，文字插在光标处（不覆盖、不清空）；插不进去时（比如正在发送）会报错，选取留在列表里可重试。
- 改 `client.js` 需要刷新一次 DSH 窗口；改 `web/overlay.js` 只要重新加载被看的页面。

## License

MIT（webview 注入方案参考 [FleatherYu/dsh-webannotate](https://github.com/FleatherYu/dsh-webannotate)，MIT）。
