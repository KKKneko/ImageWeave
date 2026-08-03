import crawlApplication from "../apps/crawl.js";
import tasksApplication from "../apps/tasks.js";
import proxyApplication from "../apps/proxy.js";
import vaultApplication from "../apps/vault.js";
import reviewApplication from "../apps/review.js";
import policyApplication from "../apps/policy.js";
import diagnosticsApplication from "../apps/diagnostics.js";
import personalizationApplication from "../apps/personalization.js";
import { createPlaceholderApplication } from "../apps/placeholder.js";

const definitions = [
  {
    id: "crawl",
    label: "图片采集",
    icon: "download",
    route: "/crawl",
    windowTitle: "C:\\IMAGEWEAVE\\CRAWL.EXE",
    availability: "ready",
    defaultWindowState: "normal",
    application: crawlApplication,
  },
  {
    id: "tasks",
    label: "批次管理",
    icon: "list",
    route: "/tasks",
    windowTitle: "C:\\IMAGEWEAVE\\TASKMGR.EXE",
    availability: "ready",
    defaultWindowState: "normal",
    application: tasksApplication,
  },
  {
    id: "proxy",
    label: "代理管理",
    icon: "network",
    route: "/proxy",
    windowTitle: "C:\\IMAGEWEAVE\\PROXY.CPL",
    availability: "ready",
    defaultWindowState: "normal",
    application: proxyApplication,
  },
  {
    id: "vault",
    label: "授权管理",
    icon: "key",
    route: "/vault",
    windowTitle: "C:\\IMAGEWEAVE\\VAULT.CPL",
    availability: "ready",
    defaultWindowState: "normal",
    application: vaultApplication,
  },
  {
    id: "review",
    label: "去重审核",
    icon: "images",
    route: "/review",
    windowTitle: "C:\\IMAGEWEAVE\\REVIEW.EXE",
    availability: "ready",
    defaultWindowState: "maximized",
    application: reviewApplication,
  },
  {
    id: "policy",
    label: "站点设置",
    icon: "sliders",
    route: "/policy",
    windowTitle: "C:\\IMAGEWEAVE\\POLICY.CPL",
    availability: "ready",
    defaultWindowState: "normal",
    application: policyApplication,
  },
  {
    id: "diagnostics",
    label: "系统诊断",
    icon: "activity",
    route: "/diagnostics",
    windowTitle: "C:\\IMAGEWEAVE\\DIAG.EXE",
    availability: "ready",
    defaultWindowState: "normal",
    application: diagnosticsApplication,
  },
  {
    id: "personalization",
    label: "外观设置",
    icon: "sliders",
    route: "/personalization",
    windowTitle: "C:\\IMAGEWEAVE\\DESKTOP.CPL",
    availability: "ready",
    defaultWindowState: "normal",
    application: personalizationApplication,
  },
  {
    id: "gallery",
    label: "图片库",
    icon: "folder",
    route: "/gallery",
    windowTitle: "C:\\IMAGEWEAVE\\GALLERY.EXE",
    availability: "placeholder",
    defaultWindowState: "normal",
    application: createPlaceholderApplication("浏览和搜索已下载的图片。"),
  },
  {
    id: "schedule",
    label: "定时任务",
    icon: "calendar",
    route: "/schedule",
    windowTitle: "C:\\IMAGEWEAVE\\SCHEDULE.EXE",
    availability: "placeholder",
    defaultWindowState: "normal",
    application: createPlaceholderApplication("按计划自动启动采集任务。"),
  },
  {
    id: "export",
    label: "数据集导出",
    icon: "archive",
    route: "/export",
    windowTitle: "C:\\IMAGEWEAVE\\EXPORT.EXE",
    availability: "placeholder",
    defaultWindowState: "normal",
    application: createPlaceholderApplication("将审核后的图片整理并导出为数据集。"),
  },
];

function validateDefinitions(items) {
  const ids = new Set();
  const routes = new Set();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`应用 ID 重复：${item.id}`);
    if (routes.has(item.route)) throw new Error(`应用路由重复：${item.route}`);
    if (!item.route.startsWith("/") || item.route.includes("?") || item.route.includes("#")) {
      throw new Error(`应用路由格式无效：${item.route}`);
    }
    for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
      if (typeof item.application[hook] !== "function") {
        throw new Error(`${item.id} 缺少生命周期方法：${hook}`);
      }
    }
    ids.add(item.id);
    routes.add(item.route);
  }
}

validateDefinitions(definitions);

export const applications = Object.freeze(
  definitions.map(({ application, ...metadata }) => Object.freeze({ ...metadata, ...application })),
);

const applicationById = new Map(applications.map((application) => [application.id, application]));
const applicationByRoute = new Map(
  applications.map((application) => [application.route, application]),
);

export const DEFAULT_APP_ID = "crawl";
export const DEFAULT_ROUTE = applicationById.get(DEFAULT_APP_ID).route;

export function getApplicationById(id) {
  return applicationById.get(id) || null;
}

export function getApplicationByRoute(route) {
  return applicationByRoute.get(route) || null;
}
