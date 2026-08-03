import {
  DEFAULT_ROUTE,
  getApplicationById,
  getApplicationByRoute,
} from "./app-registry.js";

export function parseHashRoute(hash) {
  if (typeof hash !== "string" || !hash.startsWith("#/")) return DEFAULT_ROUTE;
  const route = hash.slice(1);
  return getApplicationByRoute(route) ? route : DEFAULT_ROUTE;
}

export function hashForRoute(route) {
  const normalized = getApplicationByRoute(route) ? route : DEFAULT_ROUTE;
  return `#${normalized}`;
}

export function resolveNavigationTarget(target) {
  if (typeof target !== "string") return DEFAULT_ROUTE;
  const byId = getApplicationById(target);
  if (byId) return byId.route;
  return getApplicationByRoute(target)?.route || DEFAULT_ROUTE;
}

export function createHashRouter(onRouteChange) {
  if (typeof onRouteChange !== "function") throw new TypeError("路由回调必须是函数");
  let started = false;

  const dispatch = (reason) => {
    const route = parseHashRoute(window.location.hash);
    const canonicalHash = hashForRoute(route);
    const canonicalized = window.location.hash !== canonicalHash;
    if (canonicalized) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${canonicalHash}`,
      );
    }
    onRouteChange(getApplicationByRoute(route), { reason, canonicalized });
  };

  const onHashChange = () => dispatch("hashchange");

  return Object.freeze({
    start() {
      if (started) return;
      started = true;
      window.addEventListener("hashchange", onHashChange);
      dispatch("initial");
    },

    navigate(target) {
      const route = resolveNavigationTarget(target);
      const nextHash = hashForRoute(route);
      if (window.location.hash === nextHash) {
        dispatch("same-route");
      } else {
        window.location.hash = nextHash;
      }
    },

    stop() {
      if (!started) return;
      started = false;
      window.removeEventListener("hashchange", onHashChange);
    },
  });
}
