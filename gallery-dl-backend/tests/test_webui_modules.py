from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


class WebUiModuleTests(unittest.TestCase):
    def test_business_modules_static_security_boundaries(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"

        app_endpoints = {
            "proxy.js": {
                "/api/v1/proxy/status",
                "/api/v1/proxy/start",
                "/api/v1/proxy/reload",
                "/api/v1/proxy/probe",
                "/api/v1/proxy/stop",
                "/api/v1/proxy/sources",
                "/api/v1/proxy/sources/subscriptions",
                "/api/v1/proxy/sources/node-file",
                "/api/v1/proxy/sources/inline-nodes",
                "/api/v1/proxy/sources/override",
            },
            "vault.js": {
                "/api/v1/auth",
                "/api/v1/auth/proxy",
                "/api/v1/auth/browser-profile",
                "/api/v1/auth/pixiv/oauth/start",
                "/api/v1/auth/pixiv/oauth/session",
            },
            "policy.js": {"/api/v1/sites/policies"},
            "personalization.js": set(),
            "crawl.js": {
                "/api/v1/search",
                "/api/v1/search/autocomplete",
                "/api/v1/crawls",
            },
            "tasks.js": {"/api/v1/crawls"},
            "review.js": {"/api/v1/crawls"},
            "diagnostics.js": {
                "/healthz",
                "/readyz",
                "/api/v1/config?view=diagnostics",
                "/api/v1/scheduler/status?view=diagnostics",
            },
        }
        app_sources = {
            path.name: path.read_text(encoding="utf-8")
            for path in (webui / "js" / "apps").glob("*.js")
        }
        for name, endpoints in app_endpoints.items():
            source = app_sources[name]
            for endpoint in endpoints:
                self.assertEqual(source.count(f'"{endpoint}"'), 1, (name, endpoint))
            self.assertNotIn("createDeferredApplication", source, name)
            for hook in ("mount", "activate", "deactivate", "unmount"):
                self.assertIn(f"{hook}(", source, name)

        placeholder = app_sources["placeholder.js"]
        self.assertNotIn("/api/", placeholder)
        self.assertIn("createPlaceholderShell", placeholder)

        business_paths = [
            *(webui / "js" / "apps").glob("*.js"),
            *(webui / "js" / "components").glob("*.js"),
            *(webui / "js" / "core").glob("*-model.js"),
        ]
        combined = "\n".join(path.read_text(encoding="utf-8") for path in business_paths)
        for forbidden in (
            "fetch(",
            "globalThis.fetch",
            "XMLHttpRequest",
            "localStorage",
            "sessionStorage",
            "console.",
        ):
            self.assertNotIn(forbidden, combined)

        proxy = app_sources["proxy.js"]
        vault = app_sources["vault.js"]
        policy = app_sources["policy.js"]
        crawl = app_sources["crawl.js"]
        tasks = app_sources["tasks.js"]
        review = app_sources["review.js"]
        diagnostics = app_sources["diagnostics.js"]
        personalization = app_sources["personalization.js"]
        self.assertIn('STATUS_POLL_KEY = "proxy.status"', proxy)
        self.assertIn('AUTHORIZATION_POLL_KEY = "vault.authorization"', vault)
        self.assertNotIn("polling.start", policy)
        self.assertIn('BATCH_POLL_KEY = "batches.active"', tasks)
        self.assertIn("queueMicrotask", tasks)
        self.assertIn('REVIEW_POLL_KEY = "review.active"', review)
        self.assertIn("queueMicrotask", review)
        self.assertIn('DIAGNOSTICS_POLL_KEY = "diagnostics.snapshot"', diagnostics)
        self.assertNotIn("/api/", personalization)
        self.assertNotIn("polling.", personalization)
        self.assertIn("idempotencyKey: true", crawl)
        self.assertIn("beforeLeave()", review)
        self.assertNotIn("force: true", proxy)

        for name in ("crawl.js", "tasks.js", "review.js", "diagnostics.js"):
            source = app_sources[name]
            self.assertNotIn("/api/v1/auth", source, name)
            self.assertNotIn("/api/v1/proxy", source, name)
            self.assertNotIn("/api/v1/sites", source, name)

        store = (webui / "js" / "core" / "store.js").read_text(encoding="utf-8")
        for action in (
            'DIAGNOSTICS_RECEIVED: "diagnostics/received"',
            'CRAWL_SEARCH_RECEIVED: "crawl/searchReceived"',
            'BATCH_SNAPSHOT_RECEIVED: "batches/snapshotReceived"',
            'REVIEW_WORKSPACE_RECEIVED: "review/workspaceReceived"',
        ):
            self.assertIn(action, store)
        for sanitizer in (
            "validateDiagnosticsSnapshot",
            "validateCrawlSnapshot",
            "sanitizeBatchDetail",
            "validateReviewState",
        ):
            self.assertIn(sanitizer, store)

        review_model = (webui / "js" / "core" / "review-model.js").read_text(
            encoding="utf-8"
        )
        self.assertIn("buildReviewDecisionPayload", review_model)
        self.assertIn("reviewImageUrl", review_model)
        self.assertNotIn("relative_path:", review_model)
        crawl_model = (webui / "js" / "core" / "crawl-model.js").read_text(
            encoding="utf-8"
        )
        self.assertIn("projectCrawlSearchResponse", crawl_model)
        self.assertIn("buildCrawlPayload", crawl_model)
        self.assertIn("operations.set", crawl_model)
        crawl_view = (webui / "js" / "components" / "crawl-view.js").read_text(
            encoding="utf-8"
        )
        self.assertIn("createSourceErrorWarning", crawl_view)
        self.assertNotIn("innerHTML", crawl_view)

    def test_policy_simplified_static_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        policy_dom = (webui / "js" / "components" / "policy-dom.js").read_text(
            encoding="utf-8"
        )
        policy_view = (webui / "js" / "components" / "policy-view.js").read_text(
            encoding="utf-8"
        )
        policy_app = (webui / "js" / "apps" / "policy.js").read_text(
            encoding="utf-8"
        )
        policy_model = (webui / "js" / "core" / "policy-model.js").read_text(
            encoding="utf-8"
        )
        policy_css = (webui / "styles" / "apps" / "policy.css").read_text(
            encoding="utf-8"
        )
        registry = (webui / "js" / "core" / "app-registry.js").read_text(
            encoding="utf-8"
        )
        combined = "\n".join(
            (policy_dom, policy_view, policy_app, policy_model, policy_css)
        )

        self.assertIn('id: "policy"', registry)
        self.assertIn('label: "站点设置"', registry)
        self.assertIn('windowTitle: "C:\\\\IMAGEWEAVE\\\\POLICY.CPL"', registry)
        self.assertIn('createElement("legend", { text: "选择站点" })', policy_dom)
        for label in (
            "最大并发数",
            "重试次数",
            "首次重试等待",
            "连接方式",
            "保存设置",
            "恢复默认设置",
            "直连",
            "优先代理（不可用时直连）",
            "仅代理（不可用时失败）",
        ):
            self.assertIn(label, policy_dom)
        for field in (
            "max_concurrency",
            "retry_limit",
            "backoff_base_seconds",
            "proxy_mode",
        ):
            self.assertIn(f'"{field}"', policy_dom)
        for retired in (
            "probe_url",
            "probe_before_use",
            "node_tags",
            "http_timeout",
            "gallery_retries",
            "task_timeout_seconds",
            "download_stall_timeout_seconds",
            "eh_download",
            "extra_args",
            "真实契约边界",
            "SQLite 覆盖",
            "启动默认快照",
            "权威投影",
            "契约边界",
            "指数退避",
            "argv",
            "打开 VAULT.CPL",
            "手动刷新",
            "放弃未保存更改",
        ):
            self.assertNotIn(retired, combined)
        self.assertNotIn('policyButton("discard"', policy_dom)
        self.assertNotIn('policyButton("refresh"', policy_dom)
        self.assertNotIn('policyButton("vault"', policy_dom)
        self.assertIn("beforeLeave()", policy_app)
        self.assertIn("beforeWindowHide(visibility)", policy_app)
        self.assertIn('globalThis.addEventListener?.("beforeunload"', policy_app)
        self.assertIn('"aria-live": "polite"', policy_dom)
        self.assertIn('"aria-live": "assertive"', policy_dom)

    def test_personalization_runtime_css_static_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        runtime = (webui / "js" / "core" / "personalization.js").read_text(
            encoding="utf-8"
        )
        personalization_model = (
            webui / "js" / "core" / "personalization-model.js"
        ).read_text(encoding="utf-8")
        personalization_view = (
            webui / "js" / "components" / "personalization-view.js"
        ).read_text(encoding="utf-8")
        personalization_app = (
            webui / "js" / "apps" / "personalization.js"
        ).read_text(encoding="utf-8")
        personalization_css = (
            webui / "styles" / "apps" / "personalization.css"
        ).read_text(encoding="utf-8")
        storage_source = (webui / "js" / "core" / "storage.js").read_text(
            encoding="utf-8"
        )
        main = (webui / "js" / "main.js").read_text(encoding="utf-8")
        index = (webui / "index.html").read_text(encoding="utf-8")
        desktop_css = (webui / "styles" / "desktop.css").read_text(
            encoding="utf-8"
        )
        dialog_css = (webui / "styles" / "dialog.css").read_text(
            encoding="utf-8"
        )
        status_css = (webui / "styles" / "status.css").read_text(
            encoding="utf-8"
        )
        tokens_css = (webui / "styles" / "tokens.css").read_text(
            encoding="utf-8"
        )

        def css_block(source: str, selector: str) -> str:
            start = source.index(selector)
            opening = source.index("{", start)
            closing = source.index("}", opening)
            return source[opening + 1 : closing]

        # 运行时只接受安全模型投影与固定类；动态内联值仅限私有
        # Object URL，以及严格模型投影后的两个固定六位 HEX Token。
        self.assertIn("projectPersonalizationPreferences(preferences)", runtime)
        self.assertIn("normalizeThemeHex(projected.themeAccent)", runtime)
        self.assertIn("normalizeThemeHex(projected.themeSurface)", runtime)
        self.assertIn("deriveInterfaceThemeTone(themeSurface)", runtime)
        for symbol in (
            "WALLPAPER_FIT_CLASSES",
            "WALLPAPER_POSITION_CLASSES",
            "WALLPAPER_MASK_TONE_CLASSES",
            "WALLPAPER_MASK_STRENGTH_CLASSES",
            "WALLPAPER_BLUR_CLASSES",
            "WINDOW_OPACITY_CLASSES",
        ):
            self.assertIn(f"export const {symbol}", runtime)
        self.assertIn('"background-image"', runtime)
        self.assertIn("ownedObjectUrls.has(objectUrl)", runtime)
        self.assertIn('objectUrl.startsWith("blob:")', runtime)
        self.assertIn("JSON.stringify(objectUrl)", runtime)
        set_property_names = re.findall(
            r'\.setProperty\(\s*"([^"]+)"', runtime
        )
        self.assertEqual(len(set_property_names), runtime.count(".setProperty("))
        self.assertEqual(
            set(set_property_names),
            {
                "background-image",
                "--imageweave-accent",
                "--imageweave-surface",
            },
        )
        set_attribute_names = re.findall(
            r'\.setAttribute\(\s*"([^"]+)"', runtime
        )
        self.assertEqual(set(set_attribute_names), {"data-theme-tone"})
        self.assertEqual(
            len(set_attribute_names), runtime.count(".setAttribute(")
        )
        self.assertNotIn("cssText", runtime)
        self.assertNotIn("dataset", runtime)

        # G2 设置视图只使用两个原生颜色控件和纯文本输出；颜色不会被
        # 复制到 style/dataset。对比度只显示实际值，只有格式错误才使用
        # aria-invalid，本地预览/持久化仍经过严格六位 HEX 投影。
        self.assertNotIn("INTERFACE_THEME_CONTRAST_ADVISORY_RATIO", personalization_model)
        self.assertNotIn("INTERFACE_THEME_MIN_CONTRAST_RATIO", personalization_model)
        self.assertNotIn("界面主题对比度不足", personalization_model)
        self.assertEqual(personalization_view.count('type: "color"'), 1)
        self.assertIn('datasetName: "personalizationThemeAccent"', personalization_view)
        self.assertIn('datasetName: "personalizationThemeSurface"', personalization_view)
        self.assertIn('createElement("output"', personalization_view)
        self.assertIn('role: "status"', personalization_view)
        self.assertIn('"aria-live": "polite"', personalization_view)
        self.assertIn('"aria-invalid", "true"', personalization_view)
        self.assertIn("calculateThemeContrastRatio", personalization_view)
        self.assertIn("可正常使用", personalization_view)
        self.assertNotIn("仅供信息参考", personalization_view)
        self.assertIn("isValidInterfaceTheme", personalization_view)
        self.assertIn("deriveInterfaceThemeTone", personalization_view)
        self.assertNotIn("innerHTML", personalization_view)
        self.assertNotIn(".style", personalization_view)
        self.assertNotRegex(
            personalization_view,
            r"dataset[^\n]*(?:themeAccent|themeSurface)\.input\.value",
        )
        for source in (personalization_view, personalization_app):
            self.assertNotIn("/api/", source)
            self.assertNotIn("localStorage", source)
            self.assertNotIn("sessionStorage", source)
        self.assertEqual(
            personalization_app.count("event.target.matches(THEME_INPUT_SELECTOR)"),
            2,
        )
        self.assertIn("suppressThemePreviewPublish", personalization_app)
        self.assertIn("themeInputValuesMatchRuntimeDraft", personalization_app)
        self.assertIn("view.hasLocalThemeDraft()", personalization_app)
        self.assertIn("hasInvalidThemeDraft()", personalization_view)
        self.assertNotIn("低对比颜色尚未预览", personalization_app)
        self.assertNotIn("界面主题对比度不足", personalization_app)
        self.assertIn("已保存的主题设置不受影响", personalization_app)
        self.assertNotIn("imageweave.ui:theme", storage_source)
        self.assertIn(".personalization-theme-grid", personalization_css)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr))", personalization_css)
        self.assertIn("min-height: 44px", personalization_css)
        self.assertIn(".personalization-theme-color:focus-visible", personalization_css)
        self.assertIn("@media (forced-colors: active)", personalization_css)
        self.assertIn("border-color: CanvasText", personalization_css)

        self.assertIn(
            'wallpaperMask: document.querySelector("[data-desktop-wallpaper-mask]")',
            main,
        )
        self.assertIn(
            'windowLayer: document.querySelector("[data-window-layer]")',
            main,
        )
        self.assertIn(
            'themeRoot: document.documentElement',
            main,
        )
        self.assertIn(
            '<html lang="zh-CN" data-motion="on" data-theme-tone="light">',
            index,
        )
        self.assertIn("data-desktop-wallpaper-mask", index)
        self.assertIn("data-window-layer", index)
        self.assertIn("data-application-window", index)

        root_tokens = css_block(tokens_css, ":root")
        self.assertEqual(root_tokens.count("--imageweave-accent:"), 1)
        self.assertEqual(root_tokens.count("--imageweave-surface:"), 1)
        self.assertIn("--imageweave-accent: #46515D", root_tokens)
        self.assertIn("--imageweave-surface: #F4F1EA", root_tokens)
        self.assertNotIn("--imageweave-hue", tokens_css)
        self.assertNotIn("oklch(", tokens_css)
        self.assertNotIn("prefers-color-scheme", tokens_css)
        self.assertIn(
            "color-scheme: light",
            css_block(tokens_css, ':root[data-theme-tone="light"]'),
        )
        self.assertIn(
            "color-scheme: dark",
            css_block(tokens_css, ':root[data-theme-tone="dark"]'),
        )
        self.assertIn("@media (forced-colors: active)", tokens_css)
        forced_theme = tokens_css.split("@media (forced-colors: active)", 1)[1]
        self.assertIn("--imageweave-accent: CanvasText !important", forced_theme)
        self.assertIn("--imageweave-surface: Canvas !important", forced_theme)
        self.assertIn("color: CanvasText", forced_theme)
        self.assertIn("background: Canvas", forced_theme)

        fit_contract = {
            "cover": "object-fit: cover",
            "contain": "object-fit: contain",
            "stretch": "object-fit: fill",
        }
        for fit, declaration in fit_contract.items():
            block = css_block(
                desktop_css,
                ".desktop-wallpaper--custom.desktop-wallpaper--fit-"
                f"{fit} .desktop-wallpaper__image",
            )
            self.assertIn(declaration, block)
        tile_block = css_block(
            desktop_css,
            ".desktop-wallpaper--custom.desktop-wallpaper--fit-tile "
            ".desktop-wallpaper__image-layer",
        )
        self.assertIn("background-repeat: repeat", tile_block)
        self.assertIn("background-size: auto", tile_block)
        self.assertIn("background-position: 0 0", tile_block)

        positions = {
            "top-left": "left top",
            "top": "center top",
            "top-right": "right top",
            "left": "left center",
            "center": "center",
            "right": "right center",
            "bottom-left": "left bottom",
            "bottom": "center bottom",
            "bottom-right": "right bottom",
        }
        for position, value in positions.items():
            block = css_block(
                desktop_css,
                f".desktop-wallpaper--position-{position} .desktop-wallpaper__image",
            )
            self.assertIn(f"object-position: {value}", block)

        self.assertIn(
            ".desktop-wallpaper--custom .desktop-wallpaper__mask",
            desktop_css,
        )
        self.assertIn("mask-tone-dark", desktop_css)
        self.assertIn("mask-tone-light", desktop_css)
        for strength in range(0, 81, 5):
            block = css_block(
                desktop_css,
                ".desktop-wallpaper--custom.desktop-wallpaper--mask-strength-"
                f"{strength} .desktop-wallpaper__mask",
            )
            self.assertRegex(block, rf"opacity:\s*{strength / 100:g}\s*;")

        soft_blur = css_block(
            desktop_css,
            ".desktop-wallpaper--custom.desktop-wallpaper--blur-soft "
            ".desktop-wallpaper__image-layer",
        )
        medium_blur = css_block(
            desktop_css,
            ".desktop-wallpaper--custom.desktop-wallpaper--blur-medium "
            ".desktop-wallpaper__image-layer",
        )
        self.assertIn("inset: -4px", soft_blur)
        self.assertIn("filter: blur(4px)", soft_blur)
        self.assertIn("inset: -10px", medium_blur)
        self.assertIn("filter: blur(10px)", medium_blur)
        blur_values = [int(value) for value in re.findall(r"blur\((\d+)px\)", desktop_css)]
        self.assertTrue(blur_values)
        self.assertLessEqual(max(blur_values), 10)
        image_layer = css_block(desktop_css, ".desktop-wallpaper__image-layer")
        self.assertIn("animation: none", image_layer)
        self.assertIn("transition: none", image_layer)

        self.assertIn(
            ".desktop-wallpaper--custom ~ .desktop-icons .desktop-icon",
            desktop_css,
        )
        self.assertIn("text-shadow:", desktop_css)
        self.assertIn(".desktop-icon:focus-visible", desktop_css)
        self.assertIn('.desktop-icon[aria-current="page"]', desktop_css)

        subtle = css_block(
            desktop_css,
            ".window-layer--opacity-subtle .application-window",
        )
        soft = css_block(
            desktop_css,
            ".window-layer--opacity-soft .application-window",
        )
        self.assertIn("96%", subtle)
        self.assertIn("92%", soft)
        self.assertNotIn("opacity:", subtle + soft)
        self.assertNotRegex(desktop_css, r"imageweave-surface\)\s+(?:[0-8]\d|9[01])%")
        self.assertIn("@media (forced-colors: active)", desktop_css)
        forced_colors = desktop_css.split(
            "@media (forced-colors: active)", 1
        )[1]
        self.assertIn(".application-window", forced_colors)
        self.assertIn(".window-titlebar", forced_colors)
        self.assertIn(".window-resize-handle", forced_colors)
        self.assertIn("border-color: CanvasText", forced_colors)
        self.assertIn("background: Canvas !important", forced_colors)

        # 透明背景不使用元素 opacity，因此这些实体表面仍保持实色。
        self.assertIn("background: var(--imageweave-surface)", css_block(desktop_css, ".start-menu"))
        self.assertIn("background: var(--imageweave-surface)", css_block(desktop_css, ".taskbar"))
        self.assertIn(
            "background: var(--imageweave-surface)",
            css_block(dialog_css, ".imageweave-dialog"),
        )
        self.assertIn(
            "background: var(--imageweave-surface)",
            css_block(status_css, ".error-view"),
        )

    def test_window_manager_t12_static_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        index = (webui / "index.html").read_text(encoding="utf-8")
        manager = (webui / "js" / "core" / "window-manager.js").read_text(
            encoding="utf-8"
        )
        desktop = (webui / "js" / "core" / "desktop.js").read_text(
            encoding="utf-8"
        )
        actions = (webui / "js" / "core" / "actions.js").read_text(
            encoding="utf-8"
        )
        main = (webui / "js" / "main.js").read_text(encoding="utf-8")
        desktop_css = (webui / "styles" / "desktop.css").read_text(
            encoding="utf-8"
        )

        self.assertIn("<template data-window-template>", index)
        self.assertIn("data-window-layer", index)
        self.assertEqual(index.count('data-application-window'), 1)
        self.assertEqual(index.count('data-window-resize="'), 3)
        for direction, label in (
            ("right", "调整窗口宽度"),
            ("bottom", "调整窗口高度"),
            ("corner", "调整窗口宽度和高度"),
        ):
            self.assertIn(f'data-window-resize="{direction}"', index)
            self.assertIn(f'aria-label="{label}"', index)
        self.assertNotIn('id="window-title"', index)
        self.assertNotIn('id="app-content"', index)
        self.assertIn('role="group"', index)

        self.assertNotIn('role="dialog"', manager)
        self.assertIn("const windows = new Map()", manager)
        self.assertIn("windowTemplate.content.cloneNode(true)", manager)
        self.assertIn("onMount?.(app, bodyEl)", manager)
        self.assertIn("onUnmount?.(app, instance.bodyEl)", manager)
        self.assertIn("instance.element.style.zIndex = String(index)", manager)
        self.assertIn("setPointerCapture", manager)
        self.assertIn("releasePointerCapture", manager)
        self.assertIn('event.target.closest("button")', manager)
        self.assertIn('{ capture: true }', manager)
        self.assertNotIn('"mousemove"', manager)
        self.assertNotIn("document.onmousemove", manager)
        pointer_focus = manager[
            manager.index("const onWindowPointerDown") :
            manager.index("const onTitlebarPointerDown")
        ]
        self.assertIn("actions.focusWindow(instance.appId)", pointer_focus)
        self.assertNotIn("preventDefault", pointer_focus)
        pointer_move = manager[
            manager.index("const movePointerInteraction") :
            manager.index("const resizeFromKeyboard")
        ]
        self.assertIn("applyRect(instance.element, interaction.rect)", pointer_move)
        self.assertNotIn("actions.", pointer_move)
        self.assertIn("KEYBOARD_RESIZE_STEP = 16", manager)

        self.assertRegex(
            actions,
            r"WINDOW_LAYOUT_DEBOUNCE_MS\s*=\s*(?:3\d\d|[4-9]\d\d|\d{4,})",
        )
        self.assertIn("beginWindowInteraction", actions)
        self.assertIn("endWindowInteraction", actions)
        self.assertIn("flushWindowLayout()", actions)
        self.assertIn("mountApplication(app, bodyElement)", desktop)
        self.assertIn("unmountApplication(app)", desktop)
        self.assertIn("windowManager.focusBody()", desktop)
        self.assertIn("`window-title-${app.id}`", manager)
        self.assertIn("`app-content-${app.id}`", manager)

        self.assertIn(
            'windowLayer: document.querySelector("[data-window-layer]")',
            main,
        )
        self.assertIn(".window-layer {", desktop_css)
        self.assertIn("position: absolute", desktop_css)
        self.assertIn("inset: 0", desktop_css)
        self.assertIn(
            ".window-layer--opacity-subtle .application-window",
            desktop_css,
        )
        self.assertIn(
            ".window-layer--opacity-soft .application-window",
            desktop_css,
        )
        self.assertIn(':root[data-motion="off"] .application-window', desktop_css)
        self.assertIn("@media (prefers-reduced-motion: reduce)", desktop_css)
        self.assertIn("@media (forced-colors: active)", desktop_css)
        forced = desktop_css.split("@media (forced-colors: active)", 1)[1]
        self.assertIn("CanvasText", forced)
        self.assertIn("Canvas", forced)
        self.assertIn(".window-resize-handle", forced)

    def test_pure_javascript_modules(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("未安装 Node.js；生产运行不依赖 Node.js")

        backend_root = Path(__file__).resolve().parents[1]
        source_webui = backend_root / "gdl_backend" / "webui"
        source_test = backend_root / "tests" / "webui_modules.test.mjs"
        with tempfile.TemporaryDirectory() as temporary:
            test_root = Path(temporary)
            shutil.copytree(
                source_webui / "js",
                test_root / "gdl_backend" / "webui" / "js",
            )
            (test_root / "tests").mkdir()
            shutil.copy2(source_test, test_root / "tests" / source_test.name)
            # ESM 标记仅存在于临时测试目录，不进入 wheel 或最终运行环境。
            (test_root / "package.json").write_text(
                '{"type":"module","private":true}\n',
                encoding="utf-8",
            )
            completed = subprocess.run(
                [node, "--test", str(test_root / "tests" / source_test.name)],
                cwd=test_root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=45,
                check=False,
            )

        if completed.returncode != 0:
            self.fail(
                "WebUI 纯 JavaScript 模块测试失败：\n"
                f"STDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}"
            )


if __name__ == "__main__":
    unittest.main()
