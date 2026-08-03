# ImageWeave WebUI 界面主题个性化设计增补

> 状态：G1–G3 已实现并于 2026-08-03 完成当时策略的聚焦验收；后续最新产品决定已取消对比度有效性门槛
> 功能名称：界面主题
> 当前范围：严格六位 HEX 模型、LocalStorage 完整偏好投影、运行时 Token、`DESKTOP.CPL` 控件与完整草稿；live status 只同步显示实际对比度
> 验收边界：最新修订采用聚焦 Node/Python 契约与实际 Chrome 关键路径，不宣称原生取色弹窗、辅助技术、跨浏览器或设备矩阵

## 1. 背景与目标

桌面个性化阶段 A–F 已建立 `DESKTOP.CPL` 的完整草稿、预览、应用、取消、恢复默认和本地持久化流程。
本增补在不改变该交互模型的前提下，为应用窗口和控件使用的两个基础主题 Token 增加安全、可持久化的
个性化能力。

界面统一使用以下术语：

| 术语 | 偏好字段 | 固定 CSS Token | 含义 |
| --- | --- | --- | --- |
| 界面主题 | 两个字段组成的完整颜色对 | — | 应用窗口与控件的基础配色。 |
| 强调色 | `themeAccent` | `--imageweave-accent` | 文字、边框、焦点和硬阴影使用的主要颜色。 |
| 窗口底色 | `themeSurface` | `--imageweave-surface` | 窗口、菜单、任务栏等实体表面的基础颜色。 |

G1 已完成底层安全边界，G2 将两个主题字段接入现有设置窗口，G3 完成了当时策略的静态审计、正式
文档与真实浏览器聚焦验收。后续最新产品决定只修改“对比度是否构成门槛”：产品不替用户决定配色，
任何严格六位 HEX 颜色对都可预览、应用和持久化。其余阶段成果与 A–F 原子草稿交互模型继续保留：

1. 将强调色和窗口底色纳入现有完整个性化偏好；
2. 以严格、可计算、不可注入 CSS 的颜色模型保护运行时；
3. 在 HTML/CSS 首帧提供准确的新默认值；
4. 同时支持高对比、低对比和相同颜色等任意严格 HEX 组合；
5. 依据窗口底色自动设置固定的 `light` 或 `dark` `color-scheme`；
6. 复用现有原子偏好流程，不增加网络、后端、中央 Store 或新的持久层；
7. 用两个原生颜色控件提供可读、可键盘操作且支持 forced-colors 的设置界面；
8. 每次格式合法的 `input/change` 都立即进入完整安全草稿；只有格式非法或运行时/DOM setter 失败才阻止预览或应用。

---

## 2. 已确认的产品决策

| 编号 | 决策 | 结论 |
| --- | --- | --- |
| G-D1 | 功能名称 | 固定为“界面主题”。 |
| G-D2 | 可自定义颜色 | 仅“强调色”和“窗口底色”两项。 |
| G-D3 | 颜色能力 | 每项仅允许一种 24-bit、不透明 RGB 颜色。 |
| G-D4 | 新默认值 | 强调色 `#46515D`，窗口底色 `#F4F1EA`。 |
| G-D5 | 恢复默认值 | 与新默认值完全相同，即墨灰纸白。 |
| G-D6 | 旧视觉默认 | 原有紫色/白色不再是新安装、迁移或恢复默认的值。 |
| G-D7 | 主题方向 | 允许浅色和深色组合，不限定强调色必须比底色更深。 |
| G-D8 | 对比度策略 | **最新决定取代旧门槛**：对比度不参与输入有效性、预览、Apply 或持久化；任意颜色组合均可使用，live status 只同步显示实际比例。 |
| G-D9 | 浏览器配色提示 | 只依据窗口底色相对亮度派生 `light/dark`。 |
| G-D10 | 阶段状态 | G1 安全模型、G2 设置 UI 与 G3 最终静态/浏览器/文档聚焦验收均已完成。 |

默认组合采用克制的墨灰纸白：

```text
强调色   #46515D
窗口底色 #F4F1EA
```

按照 WCAG 相对亮度与对比度公式，默认组合的对比度约为 `7.1729:1`。界面只显示实际比例，
不设置参考门槛，也不替用户选择配色。

---

## 3. 颜色数据契约

### 3.1 唯一允许的语义

持久化和运行时只接受以下语义：

```text
#RRGGBB
```

约束如下：

- 必须以单个 `#` 开头；
- 必须紧跟六个十六进制数字；
- 每个颜色恰好表达 8-bit R、8-bit G、8-bit B，共 24 bit；
- 不允许透明度；
- 读取和原生颜色输入后续提交可接受 `a–f` 小写；
- 模型投影、运行时状态和持久化输出必须规范成 `A–F` 大写；
- 不执行 trim，前后空白同样视为非法，避免扩展出模糊语义。

示例：

| 输入 | 结果 |
| --- | --- |
| `#46515D` | 接受，保持 `#46515D`。 |
| `#f4f1ea` | 接受，投影为 `#F4F1EA`。 |
| `#123` | 拒绝：短 HEX。 |
| `#46515DFF` | 拒绝：含 alpha。 |
| `red`、`transparent` | 拒绝：颜色名。 |
| `rgb(...)`、`hsl(...)`、`oklch(...)` | 拒绝：颜色函数。 |
| `var(--token)` | 拒绝：CSS 变量引用。 |
| `url(...)` | 拒绝：URL/CSS 载荷。 |
| 任意声明、选择器或其他 CSS 文本 | 拒绝。 |

模型不得保存 CSS 文本。LocalStorage 中的两个字段始终只是规范化后的六位 HEX 字符串。

### 3.2 纯函数与常量

`js/core/personalization-model.js` 提供小而明确的不可变常量与纯函数：

- `INTERFACE_THEME_DEFAULTS`：冻结的新默认颜色对；
- `INTERFACE_THEME_PREFERENCE_KEYS`：冻结的两个字段名；
- `INTERFACE_THEME_TONE_LUMINANCE_THRESHOLD`：固定为 `sqrt(1.05 * 0.05) - 0.05`（约 `0.1791287847`）；
- `normalizeThemeHex()`：验证六位 HEX，并返回大写值或 `null`；
- `calculateSrgbRelativeLuminance()`：计算 WCAG sRGB 相对亮度；
- `calculateThemeContrastRatio()`：计算两个颜色的对比度；
- `isValidInterfaceTheme()`：只验证两个颜色是否分别为严格六位 HEX，不计算或限制对比度；
- `deriveInterfaceThemeTone()`：仅根据窗口底色返回 `light` 或 `dark`。

对象常量和偏好投影均被冻结；颜色、数值、布尔值和 tone 为原始不可变值。函数不读取 DOM、不访问存储，
也不产生网络或其他副作用。

---

## 4. WCAG 信息计算与格式验证

### 4.1 sRGB 相对亮度

每个 8-bit 通道先归一化为 `c = channel / 255`，再线性化：

```text
c_linear = c / 12.92                         当 c <= 0.04045
c_linear = ((c + 0.055) / 1.055) ^ 2.4      其他情况
```

相对亮度：

```text
L = 0.2126 * R_linear + 0.7152 * G_linear + 0.0722 * B_linear
```

### 4.2 对比度

```text
contrast = (max(L1, L2) + 0.05) / (min(L1, L2) + 0.05)
```

公式产生的信息比例不参与主题有效性判断。只要两个字段分别通过严格六位 HEX 校验，整对主题就有效，
无论颜色方向或比例是多少。因此以下组合都可使用：

- 深强调色 + 浅窗口底色；
- 浅强调色 + 深窗口底色；
- 两个颜色相同（`1.00:1`）；
- 当前实际用户组合 `#0065D1 / #7E6425`（约 `1.0122:1`）。

界面只在 live status 中显示公式算出的实际比例，不设置参考线，不标记输入无效、不设置 `aria-invalid`、
不阻止 runtime preview、Apply 或 LocalStorage。

### 4.3 失败行为

- 严格预览或写入：任一字段格式非法时，整次投影抛出 `TypeError`；
- 短 HEX、alpha、颜色名、函数、`var()`、URL/CSS 文本仍不得进入运行时或 LocalStorage；
- 任意格式合法的颜色对均可进入预览和持久化，对比度不触发失败；
- 宽容读取发现任一格式损坏值时，两个主题字段一起回退新默认；
- 整对回退不得重置同一对象内其他合法个性化偏好；
- 固定 DOM/runtime setter 失败仍按第 8 节安全回滚并阻止提交。

不提供任意 CSS 绕过路径；无需为低对比提供“仍然使用”按钮，因为严格 HEX 颜色对本来就可以直接使用。

---

## 5. 偏好模型与迁移

### 5.1 完整偏好

现有 `PERSONALIZATION_PREFERENCE_KEYS` 在 A–F 字段之后增加：

```json
{
  "themeAccent": "#46515D",
  "themeSurface": "#F4F1EA"
}
```

`PERSONALIZATION_DEFAULTS`、复制、相等比较和恢复默认 helper 均覆盖这两个字段。主题字段与壁纸、动效、
遮罩、模糊和窗口透明度共同构成一份完整偏好，不建立第二套主题草稿。

### 5.2 宽容读取

读取旧存储对象时：

1. 只检查普通对象的自有数据属性描述符；
2. 不通过属性值访问执行 getter 或 Proxy `get`；
3. 旧对象缺失主题字段时，以对应的新默认字段补齐；
4. 合法小写六位 HEX 规范为大写；
5. 若任一显式主题字段格式非法，两个主题字段一起回退默认；
6. 任意对比度的合法整对均保留，不因对比度回退；
7. 其他合法字段，例如 `taskbarDensity`、壁纸设置和动效值，继续保留；
8. 旧动效值 `system/reduced` 继续按 A–F 规则迁移为 `on/off`。

该策略使旧版本完全没有主题字段的对象自动迁移到墨灰纸白，也防止只恢复半个损坏主题。

### 5.3 严格投影和写入

严格路径执行以下规则：

- 输入必须是普通对象；
- 只允许完整个性化字段白名单；
- 未知字符串字段、Symbol 字段和访问器字段全部拒绝；
- 主题颜色只接受六位 HEX；
- 合法小写输入先规范成大写；
- 两个主题字段分别通过严格六位 HEX 校验；
- 对比度不参与严格投影；
- 输出总是完整、规范化的偏好对象。

严格路径供草稿预览、提交和 Storage 写入共同使用。G2 原生 `input[type="color"]` 产生的小写值无需
特殊旁路，视图输出和安全草稿统一显示、保存为大写。

---

## 6. 存储边界

界面主题继续使用现有 LocalStorage UI preference key：

```text
imageweave.ui:ui-preferences
```

不得新增主题专用 key。`storage.js` 的职责保持为：

- 宽容读取并迁移旧完整偏好；
- 严格投影后写入完整偏好；
- `writePersonalizationPreferences()` 更新个性化字段时保留合法 `taskbarDensity`；
- 继续保留既有 animations 迁移；
- 不保存 CSS 声明、选择器、`var()`、URL、Blob URL 或其他载荷。

本功能不使用新的 IndexedDB。现有 IndexedDB 仍只服务本地壁纸 Blob，主题颜色不进入其中。

---

## 7. 首帧与 `color-scheme`

### 7.1 安全首帧

`styles/tokens.css` 的 `:root` 直接声明准确默认值：

```css
--imageweave-accent: #46515D;
--imageweave-surface: #F4F1EA;
```

旧 `--imageweave-hue`、紫色 HEX 和覆盖它的 OKLCH 重复声明均移除，确保 JavaScript 尚未执行或启动失败时
也显示准确的墨灰纸白。

HTML 根元素固定包含：

```html
data-theme-tone="light"
```

这与默认窗口底色 `#F4F1EA` 一致，避免首帧属性和 CSS 默认互相矛盾。

### 7.2 tone 派生

只使用窗口底色相对亮度决定 tone。阈值取标准黑色前景和白色前景对同一底色的对比度相等点：

```text
(L + 0.05) / 0.05 = 1.05 / (L + 0.05)
threshold = sqrt(1.05 * 0.05) - 0.05 ≈ 0.1791287847
```

底色在该阈值以上（含阈值）使用 `light`，以下使用 `dark`：

```text
surface luminance >= threshold  → light
surface luminance <  threshold  → dark
```

根元素只暴露固定属性和值：

```text
data-theme-tone="light"
data-theme-tone="dark"
```

CSS 只提供两个固定规则：

```css
:root[data-theme-tone="light"] { color-scheme: light; }
:root[data-theme-tone="dark"]  { color-scheme: dark; }
```

不得通过 `prefers-color-scheme` 自动替换用户选择，不从壁纸、时间或系统主题猜测颜色。

### 7.3 forced-colors

`forced-colors: active` 时交给系统颜色：

```css
--imageweave-accent: CanvasText !important;
--imageweave-surface: Canvas !important;
color: CanvasText;
background: Canvas;
```

系统色覆盖运行时内联 Token，确保高对比度/强制颜色模式不受自定义颜色干扰。该模式不写回偏好，也不修改
用户保存的颜色对。

---

## 8. 运行时应用与失败原子性

`main.js` 创建 `createPersonalizationRuntime()` 时显式注入：

```js
themeRoot: document.documentElement
```

运行时只允许以下主题 DOM 操作：

```js
style.setProperty("--imageweave-accent", strictHexAccent)
style.setProperty("--imageweave-surface", strictHexSurface)
setAttribute("data-theme-tone", fixedTone)
```

约束：

- 属性名、CSS Token 名均为源码中的固定字面量；
- 两个值必须先经过模型严格投影与大写规范化；
- tone 只能由严格窗口底色派生为 `light/dark`；
- 不使用 `dataset`；
- 不使用 `cssText`；
- 不接受调用方提供属性名、Token 名或 CSS 文本；
- 既有壁纸运行时唯一额外动态内联值仍是本闭包创建并持有的私有 `blob:` Object URL。

### 8.1 同步点

主题与现有完整偏好在以下路径共同应用：

1. 构造运行时后的同步首帧；
2. LocalStorage 恢复；
3. 草稿 `preview()`；
4. `commit()`；
5. `cancel()`；
6. 现有“恢复默认”调用产生的默认草稿预览；
7. 自定义壁纸缺失/损坏恢复等完整偏好重投影；
8. `destroy()` 恢复最后提交状态。

主题预览不写存储；提交仍通过一次完整偏好写入完成。

### 8.2 DOM setter 部分失败

写入前先读取两个内联 Token 和 tone 的安全快照。随后按固定顺序写强调色、窗口底色和 tone。

任一 setter 失败时，即使它已经改变 DOM 后才抛出异常，运行时仍分别尝试：

1. 恢复先前 tone，或在此前不存在时移除固定属性；
2. 恢复/移除先前窗口底色内联值；
3. 恢复/移除先前强调色内联值。

每一步单独容错，单个恢复失败不阻止其余恢复。草稿预览会回到上一份安全完整偏好。

构造阶段的主题 setter 失败不得抛出到桌面壳层：

- 其他壁纸和动效偏好继续尽力应用；
- HTML/CSS 的墨灰纸白保持安全回退；
- IndexedDB 初始化和业务应用启动不被阻断。

---

## 9. G2 `DESKTOP.CPL` 控件与完整草稿

### 9.1 实际控件

`DESKTOP.CPL` 在“动效”之后、“背景来源”之前提供“界面主题” fieldset：

- “强调色”：原生 `input[type="color"]`，固定选择器
  `data-personalization-theme-accent`；
- “窗口底色”：原生 `input[type="color"]`，固定选择器
  `data-personalization-theme-surface`；
- 每项都有显式 `<label for>`，旁边的 `<output>` 只以纯文本显示规范化大写 `#RRGGBB`；
- 原生颜色输入自身显示色块，不把用户颜色复制到 `style`、dataset、CSS 文本或任意文本编辑器；
- 两个输入共同引用帮助文本与整对对比状态；只有严格 HEX 格式非法时才设置 `aria-invalid="true"`，低对比不会设置；
- 整对状态使用 `role="status" aria-live="polite" aria-atomic="true"`，显示保留两位小数的实际对比度、
  “浅色界面”或“深色界面”，以及当前配色可预览并应用；
- busy 时 fieldset 和两个颜色输入均禁用；颜色控件最小交互高度为 44px，并提供明确
  `:focus-visible`；forced-colors 下使用系统色保持可读。

视图初始值、`renderState()` 和 `readDraft()` 均覆盖 `themeAccent/themeSurface`。页头摘要、dirty/clean
状态、恢复默认说明、放弃确认和删除壁纸确认均明确提及界面主题。

### 9.2 格式合法颜色的即时结算

最新决定取消了 G2 当时的低对比本地中间态。当前状态机如下：

```text
安全运行时草稿
→ 用户 input/change 修改任一颜色
→ 两项都是严格六位 HEX：一次读取当前完整表单
→ 一次 runtime.preview 立即应用固定 Token/tone
→ 轻量 accept 同步最新 dirty/Apply；不写 LocalStorage
→ live status 同步显示实际对比度，不改变 preview 与 Apply 状态
→ 用户点击 Apply：一次 commit 写入完整偏好
```

当前实际用户组合 `#0065D1 / #7E6425` 的比例约为 `1.01:1`，按上述路径即时进入 runtime draft，
Apply enabled，提交后规范化值可从 LocalStorage 重新读取。相同颜色形成的 `1.00:1` 组合行为一致。

只在以下情况保留本地主题表单态并阻断提交：任一值不是严格 `#RRGGBB`，或 runtime/DOM setter 失败。
该状态只保存布尔标志，实际表单值仍只存在于原生控件，不复制进第二套模型、Store 或持久层；Cancel 和
生命周期清理会恢复最后提交值。其他普通控件不能绕过真正的格式或 setter 错误。

### 9.3 dirty、Apply 与离开守卫

有效运行时草稿 dirty 与仅因格式/setter 错误保留的 DOM 本地主题草稿共同构成“有未应用更改”并参与离开守卫：

- 本地主题草稿存在时，根视图 `data-dirty="true"`；
- Apply 必须同时满足：运行时草稿 dirty、无格式/setter 错误本地态、无 busy，且自定义图片来源可提交；
- 切换应用、最小化、关闭窗口和 `beforeunload` 都同时检查两类 dirty；
- 取消离开会保留表单中间颜色；确认放弃调用现有完整 `cancel()` 并清理中间态；
- Cancel、恢复默认、`activate()`、`deactivate()` 和 `destroy()` 都显式清理本地主题状态；
- 恢复默认继续通过一次现有 `preview(restoreDefaultPersonalizationPreferences())` 预览完整默认偏好，仍需原有
  Apply 才写入；
- Apply 仍只调用一次现有 `commit()`，主题与桌面偏好一起写入既有 UI preference key。

新图片选择和删除属于异步持久化边界，存在格式/setter 错误本地态时会被禁用并在控制器中再次防御；
普通选择控件仍可调整，但要先修正真正错误后才能随完整表单进入安全草稿。低对比本身不会禁用图片操作。

### 9.4 失败语义

- 低对比不是错误：格式合法时照常调用运行时、预览并允许 Apply，状态只显示实际比例；
- 颜色格式非法时保留表单值、设置 `aria-invalid`，且不调用运行时；
- 合法颜色进入 `runtime.preview()` 后若严格投影或固定 DOM setter 失败，G1 负责恢复此前 Token/tone 和草稿；
- 控制器保留当前表单值、禁用 Apply，并显示不包含底层异常细节的受控错误；
- 视图回显 setter 失败时尽力恢复控件旧值，控制器同样阻止提交；
- 上述失败路径不调用 `commit()`，因此不会错误写入 LocalStorage；
- Cancel 或明确生命周期清理后，表单重新回显最后提交的完整偏好。

### 9.5 交互可靠性修复

针对原生取色器连续交互时的卡顿和 Apply 长期不可用问题，主题输入链增加以下可靠性约束：

- 同时监听 `input` 与 `change`：`input` 继续提供即时安全预览，`change` 作为部分 Chromium/桌面原生
  取色器只可靠通知最终值时的结算兜底；
- `change` 会把当前两个输入规范化后，与 runtime 完整草稿中的主题颜色对做值级比较。若同一颜色对已由
  `input` 成功结算且不存在本地错误态，则不重复 preview；若只有 `change`，或仍有格式/预览错误的
  本地主题草稿，则必须继续结算；
- 低对比状态与其他合法配色使用相同成功状态：显示实际比例，不设置 `aria-invalid`、不驻留本地中间态，
  也不禁用 Apply；严格 HEX 投影和 LocalStorage 提交边界保持不变；
- `beginThemeDraft`、格式错误输入、成功 accept 和 preview error 使用主题轻量视图路径，只更新两个 HEX
  output、对比度/tone、必要的 `aria-invalid`、根 dirty，以及 Apply/Cancel/Reset/文件选择/删除按钮的禁用状态；
  不重复写壁纸、动效、窗口透明度或其他表单控件；
- theme preview 的同步 runtime publish 由控制器在有界 `try/finally` 区间内抑制订阅回显，返回后由轻量
  accept 同步最新 state；异常也会恢复抑制标志，后续外部 publish/busy 仍执行完整刷新并保留 DOM 中间颜色；
- runtime 对严格投影后与当前 draft 完全相等的偏好直接 no-op；仅两个主题字段变化时只原子应用固定
  `--imageweave-accent`、`--imageweave-surface` 和 `data-theme-tone`，不重做壁纸类、图片 URL、窗口透明度类
  或 motion；只要同时包含其他完整偏好变化，就仍执行一次完整 `applyDraft()`；
- 不引入持续 rAF、轮询、无期限 timer 或复杂 debounce，最终值由事件兼容、值级去重和轻量路径直接结算。

G3 当时曾在实际 Chrome 页面复验旧策略：仅发送 `change` 的低对比第一步会保留表单值且不改
Token/Storage，第二个 `change` 达到当时门槛后结算；连续同步发送 240 个有效 `input` 的脚本耗时约
`56.8ms`，等待两次绘制总计约 `71.3ms`。**其中“低对比驻留并禁用 Apply”只属于历史证据，已被
最新产品决定取代，不再描述当前行为。** 当前实现继续保留该证据验证过的事件兼容、值级去重、同步
publish 抑制、轻量刷新与 runtime no-op/theme-only 快路径；本次修订未执行浏览器性能测试，也不虚构
对操作系统原生取色弹窗的自动化控制。

---

## 10. 安全、隐私与架构边界

本阶段明确不增加：

- 任意 CSS/文本主题编辑器；
- alpha、短 HEX、颜色名或颜色函数；
- 远程主题、主题 URL 或主题资源下载；
- 后端 API、上传、同步或遥测；
- 中央 Store slice；
- 新 LocalStorage key；
- 新 IndexedDB 数据库、对象仓库或记录；
- 新的长期 Object URL；
- `prefers-color-scheme` 驱动的自动换色；
- 从壁纸自动提取颜色。

主题值不进入 URL、dataset、日志、业务 API 或壁纸 Blob 记录。

---

## 11. G1–G3 实现与文档落点

| 文件 | 阶段 | 实际结果 |
| --- | --- | --- |
| `webui/js/core/personalization-model.js` | G1/最新修订 | 新字段、默认值、HEX 规范化、亮度、实际对比度计算、仅格式整对验证、tone、迁移与严格投影。 |
| `webui/js/core/storage.js` | G1 | 继续使用现有 UI preference key；借助完整模型自动迁移、严格写入并保留 taskbar/animations 规则。 |
| `webui/js/core/personalization.js` | G1 | 固定 Token 与根 tone 应用、完整草稿生命周期、setter 快照和尽力原子恢复。 |
| `webui/js/main.js` | G1 | 显式注入 `document.documentElement` 作为 `themeRoot`。 |
| `webui/styles/tokens.css` | G1 | 准确墨灰纸白首帧、固定 light/dark 规则与 forced-colors 系统色。 |
| `webui/index.html` | G1 | 根节点准确 `data-theme-tone="light"`。 |
| `webui/js/components/personalization-view.js` | G2/最新修订 | fieldset、两个原生颜色输入、大写输出、实际对比度状态、ARIA、busy，以及只为格式/setter 错误保留的表单态。 |
| `webui/js/apps/personalization.js` | G2 | `input` 即时预览、`change` 最终兜底与值级去重；完整表单一次预览；Apply/dirty/离开守卫、清理和受控错误。 |
| `webui/styles/apps/personalization.css` | G2 | 宽屏两列、窄屏单列、44px 控件、非颜色状态差异、焦点和 forced-colors。 |
| `tests/webui_modules.test.mjs` | G1/G2/最新修订 | 模型、存储、runtime preview/commit/restore、视图/controller input/change/Apply、低对比真实组合及失败保护。 |
| `tests/test_webui_modules.py` | G1/G2 | 固定运行时 Token/tone 与 G2 无动态颜色 style/dataset、无存储/API 旁路的静态契约。 |
| `README.md`、`gallery-dl-backend/README.md` | G3/最新修订 | 同步墨灰纸白默认、两色自定义、实际对比度显示、任意颜色组合可用、自动浅深提示及本地安全边界。 |
| `docs/webui-desktop-personalization.md`、`gallery-dl-backend/docs/WEBUI_REWRITE.md` | G3/最新修订 | 保留 A–F/重写历史语境，标明旧低对比禁用策略已被后续决定取代，并记录当前无门槛语义。 |
| `docs/assets/imageweave-webui.png` | G3 | 真实浏览器捕获的新默认主题与 `DESKTOP.CPL` 主题控件截图，PNG `2880×2000`。 |

---

## 12. 验收清单

### 12.1 G1 基础

1. [x] 默认与恢复默认均为 `#46515D / #F4F1EA`。
2. [x] 原有紫白声明不再覆盖新默认。
3. [x] 只接受六位不透明 HEX，合法小写输出为大写。
4. [x] alpha、短 HEX、颜色名、函数、`var()`、URL 和任意 CSS 被拒绝。
5. [x] 默认组合实际对比度约 `7.17:1`；界面不设置对比参考门槛。
6. [x] `#0065D1 / #7E6425`、同色 `1.00:1` 等低对比组合均可进入运行时预览、提交和恢复。
7. [x] 损坏格式的持久化主题整对回退，其他合法偏好保留；格式合法的任意对比颜色不回退。
8. [x] 浅色、深色和任意对比组合均可通过，tone 只依据窗口底色亮度。
9. [x] 根元素只使用固定 `data-theme-tone="light|dark"`。
10. [x] forced-colors 使用 `CanvasText/Canvas`。
11. [x] 主题字段进入现有完整草稿、Apply、Cancel 和恢复默认原子流程。
12. [x] setter 部分失败会尽力恢复写入前的两个内联值与 tone。
13. [x] 启动主题应用失败不阻断桌面，CSS 默认值保持安全回退。
14. [x] 不增加网络、后端、Store、存储 key、IndexedDB 或长期 Object URL。

### 12.2 G2 UI 与生命周期

1. [x] “界面主题”位于动效之后、背景来源之前，字段名固定为“强调色”“窗口底色”。
2. [x] 仅使用两个有显式 label 的原生 `input[type="color"]`，无 alpha 或 CSS/文本输入旁路。
3. [x] `<output>` 纯文本显示大写 `#RRGGBB`；颜色不写入 style/dataset，也不使用 `innerHTML`。
4. [x] 整对 live status 显示实际对比度和浅/深界面，并统一说明当前配色可预览并应用。
5. [x] 两输入引用帮助和状态；低对比不设置 `aria-invalid`，只有格式非法才设置，busy 时禁用。
6. [x] 宽屏两列、窄屏单列；颜色控件至少 44px，HEX 不溢出，焦点与 forced-colors 可读。
7. [x] 任一格式合法颜色变更立即调用 preview 并更新 Token；`#0065D1 / #7E6425` 下 Apply enabled。
8. [x] `input` 与仅 `change` 两条路径都能结算，同值 `change` 不重复 preview。
9. [x] 只有格式非法或 preview/setter error 才保留本地错误态并阻止其他控件绕过验证。
10. [x] Apply 要求运行时草稿可提交且无格式/setter 错误；完整提交仍只写一次完整偏好。
11. [x] 切换应用、最小化、关闭和 beforeunload 均覆盖真正未应用草稿或错误态。
12. [x] Cancel、恢复默认、确认放弃、activate/deactivate/destroy 均恢复/清理相应草稿状态。
13. [x] runtime/DOM setter 失败保留安全界面、阻止 Apply、显示受控错误且不错误写存储。
14. [x] 删除壁纸确认明确说明已提交界面主题不受影响。
15. [x] 聚焦模块测试和静态契约已补充，不建立庞大 E2E 矩阵。

### 12.3 G3 最终静态与安全审计

最终聚焦审计确认：

1. 主题运行时只写源码固定的根 Token `--imageweave-accent`、`--imageweave-surface`，以及固定属性
   `data-theme-tone="light|dark"`；主题值不会成为属性名、Token 名、dataset 值或任意 CSS 文本。
2. 主题颜色只接受严格 `#RRGGBB`，进入模型、运行时和持久化前统一大写；界面计算并展示实际
   对比度，但不设置参考线且不参与严格路径。alpha、短 HEX、颜色名、函数、`var()`、URL、声明和
   未知字段仍不能进入严格路径。
3. 个性化视图不使用 `innerHTML`，不把用户颜色复制到 `style` 或 dataset；视图与控制器不导入
   API 客户端或中央 Store，不调用 `fetch`/XHR/轮询，也不直接访问 LocalStorage。
4. 主题继续使用既有 `imageweave.ui:ui-preferences`，没有主题专用 key；写入值是包含两个严格 HEX
   字段的规范化完整偏好对象，不含 CSS 声明、选择器、Blob URL 或其他样式载荷。
5. 低对比不会形成 DOM 错误态：它立即进入严格完整草稿，Apply 可用且 `aria-invalid` 不存在。
   只有格式非法或 setter/preview 失败才保留本地错误态并由离开守卫覆盖。
6. forced-colors 通过 `CanvasText/Canvas !important` 覆盖两个根 Token；forced-colors 或
   `prefers-contrast: more` 下应用窗口回到实色，不通过元素 `opacity` 制造透明。
7. `<768px` 时主题 grid 固定单列；颜色输入高 `44px` 且最小宽 `44px`，HEX 输出允许收缩并限制在
   容器内。上述静态契约与真实 `390×844` 浏览器场景一致。
8. 壁纸 A–F 既有边界保持不变：运行时另一个固定 `setProperty("background-image", ...)` 仍只接收
   本闭包创建并持有的私有 `blob:` URL，不属于主题颜色写入；本阶段没有修改 crawl、discovery 或
   proxy 语义。

### 12.4 历史 G3 浏览器证据（旧低对比策略已被取代）

G3 当时使用 **Chrome 150** 在 **1440×1000** 桌面 viewport 完成以下浏览器验收。这些记录是历史
证据，不表示本次最新修订重新执行了浏览器测试：

- 首次加载根 Token、`data-theme-tone="light"`、`color-scheme: light`、`7.17:1` 状态及空
  LocalStorage 均符合当时预期；
- **历史旧策略**曾把同色 `1.00:1` 留在 DOM、设置 `aria-invalid` 并禁用 Apply；这一行为已被最新
  产品决定明确取代，不能继续作为当前要求；
- 当时验证了 `#F4F1EA / #101010` 与 `#FFFFFF / #101010` 的深色预览、Apply/刷新、恢复默认/Cancel；
- **390×844** 移动仿真曾确认单列 grid、44px 颜色输入和无水平溢出；
- forced-colors 与 `prefers-contrast` 联合仿真曾确认 `CanvasText / Canvas`、实色窗口与不写偏好。

当前实现把同色及 `#0065D1 / #7E6425`（约 `1.01:1`）视为正常主题。最新实际 Chrome
复验确认该组合即时写入两个固定 Token、无 `aria-invalid`、Apply enabled，提交后 LocalStorage 保存
规范化大写值；随后已把测试前保存偏好逐字节恢复。连续同步发送 240 个主题 `input` 耗时约 `42.3ms`，
Apply 保持可用且未写存储。该复验没有自动控制操作系统原生取色弹窗，也不代表屏幕阅读器、全部键盘
路径、其他浏览器或设备矩阵。

### 12.5 最新修订的自动化命令与结果

本次取消对比度门槛的修订只执行以下关键验证：

```bash
cd gallery-dl-backend
node --test tests/webui_modules.test.mjs

node --check gdl_backend/webui/js/core/personalization-model.js
node --check gdl_backend/webui/js/core/personalization.js
node --check gdl_backend/webui/js/components/personalization-view.js
node --check gdl_backend/webui/js/apps/personalization.js
node --check tests/webui_modules.test.mjs

.venv/bin/python -m unittest \
  tests.test_webui_modules.WebUiModuleTests.test_personalization_runtime_css_static_contract

cd ..
git diff --check
```

Node 模块测试 **72/72**、相关 `node --check` **5/5**、一个 Python WebUI 契约 **1/1** 均通过，
`git diff --check` 无输出。首次从仓库根直接执行相对测试路径时因工作目录不符而未找到文件，切换到
`gallery-dl-backend/` 后上述正式命令通过。未运行完整后端、crawl/discovery/proxy、原生取色弹窗、
辅助技术、跨浏览器或跨设备回归矩阵。

### 12.6 最新修订完成清单

- [x] `isValidInterfaceTheme`、宽容规范化和严格投影仅以严格六位 HEX 格式判断合法性。
- [x] `#0065D1 / #7E6425` 与同色组合可 preview、Apply、commit 和重新读取；低对比无 `aria-invalid`。
- [x] live status 只显示实际对比度，不设置建议线或低对比警告。
- [x] alpha、短 HEX、颜色名、函数、`var()`、URL/CSS 文本仍被拒绝。
- [x] runtime/DOM setter failure 仍回滚、保留受控错误并阻止持久化。
- [x] 保留 input+change、同值去重、同步 publish 抑制、主题轻量刷新及 runtime no-op/theme-only 快路径；未引入 rAF、轮询、timer 或 debounce。
- [x] 同步根 README、后端 README、桌面个性化历史文档和 WebUI 重写文档。
- [x] 执行第 12.5 节聚焦自动化，并在实际 Chrome 验证任意配色预览、Apply、提交、恢复及连续输入快路径。
- [x] 未修改 crawl/discovery/proxy 语义，未创建 commit。
