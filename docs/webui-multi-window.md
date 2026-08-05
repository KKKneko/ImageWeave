# WebUI 多窗口架构

ImageWeave WebUI 使用单页桌面壳层承载多个应用窗口。每个 `appId` 最多对应一个窗口实例；
窗口栈、焦点、DOM 生命周期和轮询调度都由同一份中央状态派生，应用模块不自行维护第二套窗口状态。

## 窗口栈状态

窗口状态位于 `state.ui`：

```js
{
  windows: [
    {
      appId: "crawl",
      windowState: "normal", // normal | maximized | minimized
      rect: { x: 160, y: 64, w: 800, h: 560 },
    },
  ],
  focusedAppId: "crawl", // 或 null
  startMenuOpen: false,
}
```

约定如下：

- `windows` 的数组顺序就是从底到顶的 z 序；DOM `z-index` 只是该顺序的投影，不写回状态。
- 同一 `appId` 只保留一条记录。再次打开会恢复最小化窗口并将其移到栈顶。
- `focusedAppId` 始终是栈顶的非 `minimized` 窗口；全部最小化或窗口栈为空时为 `null`。
- `closed` 不作为 `windowState` 保存；窗口记录不存在即表示已关闭。
- `rect` 保存普通窗口的几何位置。最大化和移动端强制最大化都不覆盖该矩形，恢复时继续使用原值。

## 布局持久化

窗口布局保存在浏览器本地存储键 `imageweave.window-layout.v1` 中。`v1` 是布局格式版本，
当前值形状为：

```json
{
  "windows": [
    {
      "appId": "crawl",
      "windowState": "normal",
      "rect": { "x": 160, "y": 64, "w": 800, "h": 560 }
    }
  ]
}
```

读取时只接受已注册且可用的应用、固定窗口状态和有限数值矩形；重复应用会按最后一条记录去重，
矩形会按当前视口与任务栏可用区收敛。损坏、未知或旧格式数据不会直接进入 store，而会回退到
安全默认布局并以当前格式修复。布局只包含应用标识、窗口状态和几何信息，不保存业务数据或凭据。

## 应用 DOM 与生命周期

壳层为每个窗口创建独立的应用根元素，并通过 `context.root` 传给应用的 `mount(context)`。
应用及其视图组件只能在该根元素内查询和更新 DOM，不得通过全局固定 selector 获取应用节点。

生命周期分工为：

- `activate`：恢复可交互状态，并启动该窗口当前需要的读取或轮询；
- `deactivate`：在真实最小化或关闭时中止在途请求、停止应用轮询、关闭临时交互并设置 `inert`；
- `unmount`：解绑根元素与全局事件、取消订阅、释放图片/Object URL 等资源并清空模块级实例；
- 壳层在停用和卸载后还会执行 `stopScope("app:<appId>")`，作为应用清理之外的统一防线。

普通桌面切焦不会卸载或停用仍打开的窗口，因此多个应用可以并列显示并保留各自界面状态。

## 聚焦感知轮询

应用轮询使用 `scope="app:<appId>"`。壳层将 store 中的 `focusedAppId` 与 `windows`
投影为只读 `focusSource`，状态只有 `open`、`minimized`、`closed` 和 `unmanaged`；轮询层不读取
窗口矩形或业务 slice。调度优先级从高到低为：

1. 页面为 `hidden` 时，所有非关键 entry 挂起；既有 `critical: true` 页面隐藏例外保持不变。
2. 应用窗口为 `minimized` 或 `closed` 时挂起，并中止该 entry 的活动请求。
3. 已打开且带 `alwaysFocusRate: true` 的 entry 使用基础周期。
4. 聚焦窗口使用基础周期。
5. 已打开但未聚焦的窗口使用基础周期的 `4` 倍。
6. `shell`、`global` 等非应用 scope 属于 `unmanaged`，始终使用基础周期。

`alwaysFocusRate` 只用于 VAULT 的活动授权会话轮询；它不能绕过页面隐藏、窗口最小化或关闭。
任务栏系统摘要使用 `scope="shell"`，基础周期保持 30 秒，不会因窗口切焦而降频或重置 deadline。
未提供 `focusSource` 的独立调用保持原有基础周期行为。

状态变化时，每个 entry 最多保留一个 timer。进入挂起会清除 timer 并发出 abort；活动 Promise
保持单飞，结束后再安排唯一后续任务。从降频或挂起恢复到聚焦时继续遵循 entry 的恢复策略：
`immediate` 立即读取一次，`interval` 等待一个新的基础周期。页面重新可见时采用同一套恢复语义。

## 移动端降级

在不超过 `767px` 的视口中，窗口管理器采用单窗口呈现：

- 所有非最小化窗口在视图层强制最大化，只有 `focusedAppId` 对应窗口可见；
- 未聚焦窗口只是移动端展示抑制，仍保持 `open`，不会被误当成最小化或卸载；
- 真实 `minimized` 状态继续停用应用，并可从任务栏恢复；
- 拖动、自由缩放和最大化切换被禁用，窗口 resize handle 从键盘顺序中移除；
- 离开移动断点后，原 `windowState` 与普通窗口 `rect` 原样恢复。

因此移动端不会把临时单窗口展示写回持久化布局；仍打开但未聚焦的应用轮询按普通未聚焦规则降频。

## 无障碍约定

- 每个窗口使用独立标题 ID 与 `aria-labelledby`，窗口操作按钮提供稳定中文名称；最大化状态通过
  `aria-pressed` 表达。
- 桌面端 resize handle 是可聚焦按钮，支持方向键按固定步长调整，并具有方向明确的
  `aria-label`；移动端禁用时同时隐藏并移出 Tab 顺序。
- 任务栏每个窗口都有可读应用标签。聚焦窗口使用 `aria-pressed="true"`，最小化窗口在
  `aria-label` 中明确标注；溢出列表通过 `aria-controls`、`aria-expanded` 和 Escape 返回焦点。
- 隐藏或停用的应用根元素同时使用 `hidden` 与 `inert`，避免焦点进入不可见窗口。
- “跳到当前应用”链接把键盘焦点送到聚焦窗口正文；路由变化通过 `aria-live="polite"` 公告。
- 指针聚焦窗口不阻止控件默认行为；键盘触发窗口恢复、最大化或菜单关闭后返回可预测焦点。
- 系统 reduced-motion 与 forced-colors 偏好始终优先于桌面个性化外观。
